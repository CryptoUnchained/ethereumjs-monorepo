import { RLP_EMPTY_STRING, isFalsy, isTruthy } from '@ethereumjs/util'
import { keccak256 } from 'ethereum-cryptography/keccak'

import { MapDB } from '../db'
import { verifyRangeProof } from '../proof/range'
import { ROOT_DB_KEY } from '../types'
import { bufferToNibbles, doKeysMatch, matchingNibbleLength } from '../util/nibbles'
import { TrieReadStream as ReadStream } from '../util/readStream'
import { Semaphore } from '../util/semaphore'
import { WalkController } from '../util/walkController'

import { BranchNode, ExtensionNode, LeafNode, decodeNode, decodeRawNode, isRawNode } from './node'
import { prepareTrieOpts } from './util'

import type {
  BatchDBOp,
  DB,
  EmbeddedNode,
  FoundNodeFunction,
  HashKeysFunction,
  Nibbles,
  Proof,
  PutBatch,
  TrieNode,
  TrieOpts,
} from '../types'

interface Path {
  node: TrieNode | null
  remaining: Nibbles
  stack: TrieNode[]
}

/**
 * The basic trie interface, use with `import { Trie } from '@ethereumjs/trie'`.
 * In Ethereum applications stick with the {@link SecureTrie} overlay.
 * The API for the base and the secure interface are about the same.
 */
export class Trie {
  /** The root for an empty trie */
  EMPTY_TRIE_ROOT: Buffer
  protected lock: Semaphore

  /** The backend DB */
  db: DB
  protected _root: Buffer
  protected _deleteFromDB: boolean
  protected _useHashedKeys: boolean
  protected _useHashedKeysFunction: HashKeysFunction
  protected _hashLen: number
  protected _persistRoot: boolean

  /**
   * Create a new trie
   * @param opts Options for instantiating the trie
   */
  constructor(opts?: TrieOpts) {
    this.lock = new Semaphore(1)

    this.db = opts?.db ?? new MapDB()
    this._useHashedKeys = opts?.useHashedKeys ?? false
    this._useHashedKeysFunction = opts?.useHashedKeysFunction ?? keccak256
    this.EMPTY_TRIE_ROOT = this.hash(RLP_EMPTY_STRING)
    this._hashLen = this.EMPTY_TRIE_ROOT.length
    this._root = this.EMPTY_TRIE_ROOT
    this._deleteFromDB = opts?.deleteFromDB ?? false
    this._persistRoot = opts?.persistRoot ?? false

    if (opts?.root) {
      this.root = opts.root
    }
  }

  static async create(opts?: TrieOpts) {
    return new Trie(await prepareTrieOpts(opts))
  }

  /**
   * Sets the current root of the `trie`
   */
  set root(value: Buffer) {
    if (isFalsy(value)) {
      value = this.EMPTY_TRIE_ROOT
    }
    if (value.length !== this._hashLen)
      throw new Error(`Invalid root length. Roots are ${this._hashLen} bytes`)
    this._root = value
  }

  /**
   * Gets the current root of the `trie`
   */
  get root(): Buffer {
    return this._root
  }

  /**
   * Checks if a given root exists.
   */
  async checkRoot(root: Buffer): Promise<boolean> {
    try {
      const value = await this.lookupNode(root)
      return value !== null
    } catch (error: any) {
      if (error.message === 'Missing node in DB') {
        return false
      } else {
        throw error
      }
    }
  }

  /**
   * Trie has no checkpointing so return false
   */
  get isCheckpoint() {
    return false
  }

  /**
   * Gets a value given a `key`
   * @param key - the key to search for
   * @param throwIfMissing - if true, throws if any nodes are missing. Used for verifying proofs. (default: false)
   * @returns A Promise that resolves to `Buffer` if a value was found or `null` if no value was found.
   */
  async get(key: Buffer, throwIfMissing = false): Promise<Buffer | null> {
    const { node, remaining } = await this.findPath(this.appliedKey(key), throwIfMissing)
    let value = null
    if (node && remaining.length === 0) {
      value = node.value
    }
    return value
  }

  /**
   * Stores a given `value` at the given `key` or do a delete if `value` is empty
   * (delete operations are only executed on DB with `deleteFromDB` set to `true`)
   * @param key
   * @param value
   * @returns A Promise that resolves once value is stored.
   */
  async put(key: Buffer, value: Buffer): Promise<void> {
    if (this._persistRoot && key.equals(ROOT_DB_KEY)) {
      throw new Error(`Attempted to set '${ROOT_DB_KEY.toString()}' key but it is not allowed.`)
    }

    // If value is empty, delete
    if (isFalsy(value) || value.toString() === '') {
      return await this.del(key)
    }

    await this.lock.wait()
    const appliedKey = this.appliedKey(key)
    if (this.root.equals(this.EMPTY_TRIE_ROOT)) {
      // If no root, initialize this trie
      await this._createInitialNode(appliedKey, value)
    } else {
      // First try to find the given key or its nearest node
      const { remaining, stack } = await this.findPath(appliedKey)
      // then update
      await this._updateNode(appliedKey, value, remaining, stack)
    }
    await this.persistRoot()
    this.lock.signal()
  }

  /**
   * Deletes a value given a `key` from the trie
   * (delete operations are only executed on DB with `deleteFromDB` set to `true`)
   * @param key
   * @returns A Promise that resolves once value is deleted.
   */
  async del(key: Buffer): Promise<void> {
    await this.lock.wait()
    const appliedKey = this.appliedKey(key)
    const { node, stack } = await this.findPath(appliedKey)
    if (node) {
      await this._deleteNode(appliedKey, stack)
    }
    await this.persistRoot()
    this.lock.signal()
  }

  /**
   * Tries to find a path to the node for the given key.
   * It returns a `stack` of nodes to the closest node.
   * @param key - the search key
   * @param throwIfMissing - if true, throws if any nodes are missing. Used for verifying proofs. (default: false)
   */
  async findPath(key: Buffer, throwIfMissing = false): Promise<Path> {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      const stack: TrieNode[] = []
      const targetKey = bufferToNibbles(key)

      const onFound: FoundNodeFunction = async (nodeRef, node, keyProgress, walkController) => {
        if (node === null) {
          return reject(new Error('Path not found'))
        }
        const keyRemainder = targetKey.slice(matchingNibbleLength(keyProgress, targetKey))
        stack.push(node)

        if (node instanceof BranchNode) {
          if (keyRemainder.length === 0) {
            // we exhausted the key without finding a node
            resolve({ node, remaining: [], stack })
          } else {
            const branchIndex = keyRemainder[0]
            const branchNode = node.getBranch(branchIndex)
            if (!branchNode) {
              // there are no more nodes to find and we didn't find the key
              resolve({ node: null, remaining: keyRemainder, stack })
            } else {
              // node found, continuing search
              // this can be optimized as this calls getBranch again.
              walkController.onlyBranchIndex(node, keyProgress, branchIndex)
            }
          }
        } else if (node instanceof LeafNode) {
          if (doKeysMatch(keyRemainder, node.key)) {
            // keys match, return node with empty key
            resolve({ node, remaining: [], stack })
          } else {
            // reached leaf but keys dont match
            resolve({ node: null, remaining: keyRemainder, stack })
          }
        } else if (node instanceof ExtensionNode) {
          const matchingLen = matchingNibbleLength(keyRemainder, node.key)
          if (matchingLen !== node.key.length) {
            // keys don't match, fail
            resolve({ node: null, remaining: keyRemainder, stack })
          } else {
            // keys match, continue search
            walkController.allChildren(node, keyProgress)
          }
        }
      }

      // walk trie and process nodes
      try {
        await this.walkTrie(this.root, onFound)
      } catch (error: any) {
        if (error.message === 'Missing node in DB' && !throwIfMissing) {
          // pass
        } else {
          reject(error)
        }
      }

      // Resolve if walkTrie finishes without finding any nodes
      resolve({ node: null, remaining: [], stack })
    })
  }

  /**
   * Walks a trie until finished.
   * @param root
   * @param onFound - callback to call when a node is found. This schedules new tasks. If no tasks are available, the Promise resolves.
   * @returns Resolves when finished walking trie.
   */
  async walkTrie(root: Buffer, onFound: FoundNodeFunction): Promise<void> {
    await WalkController.newWalk(onFound, this, root)
  }

  /**
   * Creates the initial node from an empty tree.
   * @private
   */
  async _createInitialNode(key: Buffer, value: Buffer): Promise<void> {
    const newNode = new LeafNode(bufferToNibbles(key), value)

    const encoded = newNode.serialize()
    this.root = this.hash(encoded)
    await this.db.put(this.root, encoded)
    await this.persistRoot()
  }

  /**
   * Retrieves a node from db by hash.
   */
  async lookupNode(node: Buffer | Buffer[]): Promise<TrieNode | null> {
    if (isRawNode(node)) {
      return decodeRawNode(node as Buffer[])
    }
    let value = null
    let foundNode = null
    value = await this.db.get(node as Buffer)
    if (value) {
      foundNode = decodeNode(value)
    } else {
      // Dev note: this error message text is used for error checking in `checkRoot`, `verifyProof`, and `findPath`
      throw new Error('Missing node in DB')
    }
    return foundNode
  }

  /**
   * Updates a node.
   * @private
   * @param key
   * @param value
   * @param keyRemainder
   * @param stack
   */
  async _updateNode(
    k: Buffer,
    value: Buffer,
    keyRemainder: Nibbles,
    stack: TrieNode[]
  ): Promise<void> {
    const toSave: BatchDBOp[] = []
    const lastNode = stack.pop()
    if (!lastNode) {
      throw new Error('Stack underflow')
    }

    // add the new nodes
    const key = bufferToNibbles(k)

    // Check if the last node is a leaf and the key matches to this
    let matchLeaf = false

    if (lastNode instanceof LeafNode) {
      let l = 0
      for (let i = 0; i < stack.length; i++) {
        const n = stack[i]
        if (n instanceof BranchNode) {
          l++
        } else {
          l += n.key.length
        }
      }

      if (
        matchingNibbleLength(lastNode.key, key.slice(l)) === lastNode.key.length &&
        keyRemainder.length === 0
      ) {
        matchLeaf = true
      }
    }

    if (matchLeaf) {
      // just updating a found value
      lastNode.value = value
      stack.push(lastNode as TrieNode)
    } else if (lastNode instanceof BranchNode) {
      stack.push(lastNode)
      if (keyRemainder.length !== 0) {
        // add an extension to a branch node
        keyRemainder.shift()
        // create a new leaf
        const newLeaf = new LeafNode(keyRemainder, value)
        stack.push(newLeaf)
      } else {
        lastNode.value = value
      }
    } else {
      // create a branch node
      const lastKey = lastNode.key
      const matchingLength = matchingNibbleLength(lastKey, keyRemainder)
      const newBranchNode = new BranchNode()

      // create a new extension node
      if (matchingLength !== 0) {
        const newKey = lastNode.key.slice(0, matchingLength)
        const newExtNode = new ExtensionNode(newKey, value)
        stack.push(newExtNode)
        lastKey.splice(0, matchingLength)
        keyRemainder.splice(0, matchingLength)
      }

      stack.push(newBranchNode)

      if (lastKey.length !== 0) {
        const branchKey = lastKey.shift() as number

        if (lastKey.length !== 0 || lastNode instanceof LeafNode) {
          // shrinking extension or leaf
          lastNode.key = lastKey
          const formattedNode = this._formatNode(lastNode, false, toSave)
          newBranchNode.setBranch(branchKey, formattedNode as EmbeddedNode)
        } else {
          // remove extension or attaching
          this._formatNode(lastNode, false, toSave, true)
          newBranchNode.setBranch(branchKey, lastNode.value)
        }
      } else {
        newBranchNode.value = lastNode.value
      }

      if (keyRemainder.length !== 0) {
        keyRemainder.shift()
        // add a leaf node to the new branch node
        const newLeafNode = new LeafNode(keyRemainder, value)
        stack.push(newLeafNode)
      } else {
        newBranchNode.value = value
      }
    }

    await this._saveStack(key, stack, toSave)
  }

  /**
   * Deletes a node from the trie.
   * @private
   */
  async _deleteNode(k: Buffer, stack: TrieNode[]): Promise<void> {
    const processBranchNode = (
      key: Nibbles,
      branchKey: number,
      branchNode: TrieNode,
      parentNode: TrieNode,
      stack: TrieNode[]
    ) => {
      // branchNode is the node ON the branch node not THE branch node
      if (isFalsy(parentNode) || parentNode instanceof BranchNode) {
        // branch->?
        if (isTruthy(parentNode)) {
          stack.push(parentNode)
        }

        if (branchNode instanceof BranchNode) {
          // create an extension node
          // branch->extension->branch
          // @ts-ignore
          const extensionNode = new ExtensionNode([branchKey], null)
          stack.push(extensionNode)
          key.push(branchKey)
        } else {
          const branchNodeKey = branchNode.key
          // branch key is an extension or a leaf
          // branch->(leaf or extension)
          branchNodeKey.unshift(branchKey)
          branchNode.key = branchNodeKey.slice(0)
          key = key.concat(branchNodeKey)
        }
        stack.push(branchNode)
      } else {
        // parent is an extension
        let parentKey = parentNode.key

        if (branchNode instanceof BranchNode) {
          // ext->branch
          parentKey.push(branchKey)
          key.push(branchKey)
          parentNode.key = parentKey
          stack.push(parentNode)
        } else {
          const branchNodeKey = branchNode.key
          // branch node is an leaf or extension and parent node is an exstention
          // add two keys together
          // dont push the parent node
          branchNodeKey.unshift(branchKey)
          key = key.concat(branchNodeKey)
          parentKey = parentKey.concat(branchNodeKey)
          branchNode.key = parentKey
        }

        stack.push(branchNode)
      }

      return key
    }

    let lastNode = stack.pop() as TrieNode
    if (isFalsy(lastNode)) throw new Error('missing last node')
    let parentNode = stack.pop()
    const opStack: BatchDBOp[] = []

    let key = bufferToNibbles(k)

    if (!parentNode) {
      // the root here has to be a leaf.
      this.root = this.EMPTY_TRIE_ROOT
      return
    }

    if (lastNode instanceof BranchNode) {
      lastNode.value = null
    } else {
      // the lastNode has to be a leaf if it's not a branch.
      // And a leaf's parent, if it has one, must be a branch.
      if (!(parentNode instanceof BranchNode)) {
        throw new Error('Expected branch node')
      }
      const lastNodeKey = lastNode.key
      key.splice(key.length - lastNodeKey.length)
      // delete the value
      this._formatNode(lastNode, false, opStack, true)
      parentNode.setBranch(key.pop() as number, null)
      lastNode = parentNode
      parentNode = stack.pop()
    }

    // nodes on the branch
    // count the number of nodes on the branch
    const branchNodes: [number, EmbeddedNode][] = lastNode.getChildren()

    // if there is only one branch node left, collapse the branch node
    if (branchNodes.length === 1) {
      // add the one remaing branch node to node above it
      const branchNode = branchNodes[0][1]
      const branchNodeKey = branchNodes[0][0]

      // look up node
      const foundNode = await this.lookupNode(branchNode)
      if (foundNode) {
        key = processBranchNode(
          key,
          branchNodeKey,
          foundNode as TrieNode,
          parentNode as TrieNode,
          stack
        )
        await this._saveStack(key, stack, opStack)
      }
    } else {
      // simple removing a leaf and recaluclation the stack
      if (parentNode) {
        stack.push(parentNode)
      }

      stack.push(lastNode)
      await this._saveStack(key, stack, opStack)
    }
  }

  /**
   * Saves a stack of nodes to the database.
   * @private
   * @param key - the key. Should follow the stack
   * @param stack - a stack of nodes to the value given by the key
   * @param opStack - a stack of levelup operations to commit at the end of this funciton
   */
  async _saveStack(key: Nibbles, stack: TrieNode[], opStack: BatchDBOp[]): Promise<void> {
    let lastRoot

    // update nodes
    while (stack.length) {
      const node = stack.pop() as TrieNode
      if (node instanceof LeafNode) {
        key.splice(key.length - node.key.length)
      } else if (node instanceof ExtensionNode) {
        key.splice(key.length - node.key.length)
        if (lastRoot) {
          node.value = lastRoot
        }
      } else if (node instanceof BranchNode) {
        if (lastRoot) {
          const branchKey = key.pop()
          node.setBranch(branchKey!, lastRoot)
        }
      }
      lastRoot = this._formatNode(node, stack.length === 0, opStack) as Buffer
    }

    if (lastRoot) {
      this.root = lastRoot
    }

    await this.db.batch(opStack)
    await this.persistRoot()
  }

  /**
   * Formats node to be saved by `levelup.batch`.
   * @private
   * @param node - the node to format.
   * @param topLevel - if the node is at the top level.
   * @param opStack - the opStack to push the node's data.
   * @param remove - whether to remove the node (only used for CheckpointTrie).
   * @returns The node's hash used as the key or the rawNode.
   */
  _formatNode(
    node: TrieNode,
    topLevel: boolean,
    opStack: BatchDBOp[],
    remove: boolean = false
  ): Buffer | (EmbeddedNode | null)[] {
    const encoded = node.serialize()

    if (encoded.length >= 32 || topLevel) {
      const hashRoot = Buffer.from(this.hash(encoded))

      if (remove) {
        if (this._deleteFromDB) {
          opStack.push({
            type: 'del',
            key: hashRoot,
          })
        }
      } else {
        opStack.push({
          type: 'put',
          key: hashRoot,
          value: encoded,
        })
      }

      return hashRoot
    }

    return node.raw()
  }

  /**
   * The given hash of operations (key additions or deletions) are executed on the trie
   * (delete operations are only executed on DB with `deleteFromDB` set to `true`)
   * @example
   * const ops = [
   *    { type: 'del', key: Buffer.from('father') }
   *  , { type: 'put', key: Buffer.from('name'), value: Buffer.from('Yuri Irsenovich Kim') }
   *  , { type: 'put', key: Buffer.from('dob'), value: Buffer.from('16 February 1941') }
   *  , { type: 'put', key: Buffer.from('spouse'), value: Buffer.from('Kim Young-sook') }
   *  , { type: 'put', key: Buffer.from('occupation'), value: Buffer.from('Clown') }
   * ]
   * await trie.batch(ops)
   * @param ops
   */
  async batch(ops: BatchDBOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === 'put') {
        if (isFalsy(op.value)) {
          throw new Error('Invalid batch db operation')
        }
        await this.put(op.key, op.value)
      } else if (op.type === 'del') {
        await this.del(op.key)
      }
    }
    await this.persistRoot()
  }

  /**
   * Saves the nodes from a proof into the trie.
   * @param proof
   */
  async fromProof(proof: Proof): Promise<void> {
    const opStack = proof.map((nodeValue) => {
      return {
        type: 'put',
        key: Buffer.from(this.hash(nodeValue)),
        value: nodeValue,
      } as PutBatch
    })

    if (this.root === this.EMPTY_TRIE_ROOT && isTruthy(opStack[0])) {
      this.root = opStack[0].key
    }

    await this.db.batch(opStack)
    await this.persistRoot()
    return
  }

  /**
   * Creates a proof from a trie and key that can be verified using {@link Trie.verifyProof}.
   * @param key
   */
  async createProof(key: Buffer): Promise<Proof> {
    const { stack } = await this.findPath(this.appliedKey(key))
    const p = stack.map((stackElem) => {
      return stackElem.serialize()
    })
    return p
  }

  /**
   * Verifies a proof.
   * @param rootHash
   * @param key
   * @param proof
   * @throws If proof is found to be invalid.
   * @returns The value from the key, or null if valid proof of non-existence.
   */
  async verifyProof(rootHash: Buffer, key: Buffer, proof: Proof): Promise<Buffer | null> {
    const proofTrie = new Trie({
      root: rootHash,
      useHashedKeysFunction: this._useHashedKeysFunction,
    })
    try {
      await proofTrie.fromProof(proof)
    } catch (e: any) {
      throw new Error('Invalid proof nodes given')
    }
    try {
      const value = await proofTrie.get(this.appliedKey(key), true)
      return value
    } catch (err: any) {
      if (err.message === 'Missing node in DB') {
        throw new Error('Invalid proof provided')
      } else {
        throw err
      }
    }
  }

  /**
   * {@link verifyRangeProof}
   */
  verifyRangeProof(
    rootHash: Buffer,
    firstKey: Buffer | null,
    lastKey: Buffer | null,
    keys: Buffer[],
    values: Buffer[],
    proof: Buffer[] | null
  ): Promise<boolean> {
    return verifyRangeProof(
      rootHash,
      firstKey && bufferToNibbles(this.appliedKey(firstKey)),
      lastKey && bufferToNibbles(this.appliedKey(lastKey)),
      keys.map((k) => this.appliedKey(k)).map(bufferToNibbles),
      values,
      proof,
      this._useHashedKeysFunction
    )
  }

  /**
   * The `data` event is given an `Object` that has two properties; the `key` and the `value`. Both should be Buffers.
   * @return Returns a [stream](https://nodejs.org/dist/latest-v12.x/docs/api/stream.html#stream_class_stream_readable) of the contents of the `trie`
   */
  createReadStream(): ReadStream {
    return new ReadStream(this)
  }

  /**
   * Creates a new trie backed by the same db.
   */
  copy(): Trie {
    return new Trie({
      db: this.db.copy(),
      deleteFromDB: this._deleteFromDB,
      useHashedKeys: this._useHashedKeys,
      useHashedKeysFunction: this._useHashedKeysFunction,
      persistRoot: this._persistRoot,
      root: this.root,
    })
  }

  /**
   * Persists the root hash in the underlying database
   */
  async persistRoot() {
    if (this._persistRoot === true) {
      await this.db.put(this.appliedKey(ROOT_DB_KEY), this.root)
    }
  }

  /**
   * Finds all nodes that are stored directly in the db
   * (some nodes are stored raw inside other nodes)
   * called by {@link ScratchReadStream}
   * @private
   */
  async _findDbNodes(onFound: FoundNodeFunction): Promise<void> {
    const outerOnFound: FoundNodeFunction = async (nodeRef, node, key, walkController) => {
      if (isRawNode(nodeRef)) {
        if (node !== null) {
          walkController.allChildren(node, key)
        }
      } else {
        onFound(nodeRef, node, key, walkController)
      }
    }
    await this.walkTrie(this.root, outerOnFound)
  }

  /**
   * Returns the key practically applied for trie construction
   * depending on the `useHashedKeys` option being set or not.
   * @param key
   */
  protected appliedKey(key: Buffer) {
    if (this._useHashedKeys) {
      return this.hash(key)
    }
    return key
  }

  protected hash(msg: Uint8Array): Buffer {
    return Buffer.from(this._useHashedKeysFunction(msg))
  }
}
