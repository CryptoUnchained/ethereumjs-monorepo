import { ConsensusAlgorithm } from '@ethereumjs/common'
import { Ethash } from '@ethereumjs/ethash'

import type { Blockchain } from '..'
import type { Consensus, ConsensusOptions } from './interface'
import type { Block, BlockHeader } from '@ethereumjs/block'
import type { EthashCacheDB } from '@ethereumjs/ethash'

/**
 * This class encapsulates Ethash-related consensus functionality when used with the Blockchain class.
 */
export class EthashConsensus implements Consensus {
  blockchain: Blockchain | undefined
  algorithm: ConsensusAlgorithm
  _ethash: Ethash | undefined

  constructor() {
    this.algorithm = ConsensusAlgorithm.Ethash
  }

  async validateConsensus(block: Block): Promise<void> {
    if (this._ethash === undefined) {
      throw new Error('blockchain not provided')
    }
    const valid = await this._ethash.verifyPOW(block)
    if (!valid) {
      throw new Error('invalid POW')
    }
  }

  /**
   * Checks that the block's `difficulty` matches the canonical difficulty of the parent header.
   * @param header - header of block to be checked
   */
  async validateDifficulty(header: BlockHeader) {
    if (this.blockchain === undefined) {
      throw new Error('blockchain not provided')
    }
    const parentHeader = (await this.blockchain.getBlock(header.parentHash)).header
    if (header.ethashCanonicalDifficulty(parentHeader) !== header.difficulty) {
      throw new Error(`invalid difficulty ${header.errorStr()}`)
    }
  }

  public async genesisInit(): Promise<void> {}
  public async setup({ blockchain }: ConsensusOptions): Promise<void> {
    this.blockchain = blockchain
    this._ethash = new Ethash(this.blockchain.db as unknown as EthashCacheDB)
  }
  public async newBlock(): Promise<void> {}
}
