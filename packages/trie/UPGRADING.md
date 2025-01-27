# Upgrading

## Disclaimer

Due to the high number of breaking changes, upgrading is typically a tedious process. Having said this, we aim to document as many breaking changes and edge cases as possible, and this is precisely what the following guide covers. Note that we actively encourage and accept PRs should you wish to contribute to and improve this guide.

## From v4 to v5

Upgrading from v4 to v5 is relatively straightforward.

### SecureTrie as an Option

In v5 the `SecureTrie` class has been removed in favor of a simple constructor option `useHashedKeys` - defaulting to `false` in the base `Trie` implementation. This reduces the level of inheritance dependencies (in the old structure it was e.g. not possible to create a secure trie without the checkpoint functionality, which are logically completely unrelated) and frees things up for future design changes and additions.

Updating is pretty much straight-forward:

```typescript
const trie = new SecureTrie() // old
```

```typescript
const trie = new CheckpointTrie({ useHashedKeys: true }) // new
```

Note that while upgrading to `CheckpointTrie` gives you guaranteed functional equivalency you might actually want to think if you need the checkpointing functionality or if you otherwise want to upgrade to a simple base trie with:

```typescript
const trie = new Trie({ useHashedKeys: true }) // new (alternative without checkpointing)
```

### Database Abstraction

Another significant change is that we dropped support for `LevelDB` out of the box. As a result, you will need to have your own implementation available.

#### Motivation

The primary reason for this change is increase the flexibility of this package by allowing developers to select any type of storage for their unique purposes. In addition, this change renders the project far less susceptible to [supply chain attacks](https://en.wikipedia.org/wiki/Supply_chain_attack). We trust that users and developers can appreciate the value of reducing this attack surface in exchange for a little more time spent on their part for the duration of this upgrade.

#### LevelDB

Prior to v5, this package shipped with a LevelDB integration out of the box. With this latest version, we have introduced a database abstraction and therefore no longer ship with the aforementioned LevelDB implementation. However, for your convenience, we provide all of the necessary steps so that you can integrate it accordingly.

##### Installation

Before proceeding with the implementation of `LevelDB`, you will need to install several important dependencies.

```shell
npm i @ethereumjs/trie @ethereumjs/util abstract-level level memory-level --save-exact
```

Note that the `--save-exact` flag will pin these dependencies to exact versions prior to installing them. We recommend carrying out this action in order to safeguard yourself against the aforementioned risk of supply chain attacks.

##### Implementation

Fortunately the implementation does not require any input from you other than copying and pasting the below code into a file of your choosing in any given location. You will then import this to any area in which you need to instantiate a trie.

```ts
import { isTruthy } from '@ethereumjs/util'
import { MemoryLevel } from 'memory-level'

import type { BatchDBOp, DB } from '@ethereumjs/trie'
import type { AbstractLevel } from 'abstract-level'

const ENCODING_OPTS = { keyEncoding: 'buffer', valueEncoding: 'buffer' }

export class LevelDB implements DB {
  readonly _leveldb: AbstractLevel<string | Buffer | Uint8Array, string | Buffer, string | Buffer>

  constructor(
    leveldb?: AbstractLevel<string | Buffer | Uint8Array, string | Buffer, string | Buffer> | null
  ) {
    this._leveldb = leveldb ?? new MemoryLevel(ENCODING_OPTS)
  }

  async get(key: Buffer): Promise<Buffer | null> {
    let value = null
    try {
      value = await this._leveldb.get(key, ENCODING_OPTS)
    } catch (error: any) {
      if (isTruthy(error.notFound)) {
        // not found, returning null
      } else {
        throw error
      }
    }
    return value as Buffer
  }

  async put(key: Buffer, val: Buffer): Promise<void> {
    await this._leveldb.put(key, val, ENCODING_OPTS)
  }

  async del(key: Buffer): Promise<void> {
    await this._leveldb.del(key, ENCODING_OPTS)
  }

  async batch(opStack: BatchDBOp[]): Promise<void> {
    await this._leveldb.batch(opStack, ENCODING_OPTS)
  }

  copy(): DB {
    return new LevelDB(this._leveldb)
  }
}
```

Now we can create an instance of the `Trie` class such as the following:

```ts
import { Trie } from '@ethereumjs/trie'
import { Level } from 'level'

import { LevelDB } from './your-level-implementation'

const trie = new Trie({ db: new LevelDB(new Level('MY_TRIE_DB_LOCATION')) })
```

##### Alternatives

If you wish to use any other database implementations, you can read and review [our recipes](./recipes) which offer various implementations of different database engines.
