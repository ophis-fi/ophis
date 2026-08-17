import type { NameContractRead, OphisNameReader } from '@cowprotocol/ens'

import { keccak256, type PublicClient } from 'viem'

export function createOphisNameReader(client: PublicClient): OphisNameReader {
  const readContract = client.readContract as unknown as (request: NameContractRead) => Promise<unknown>

  return {
    async getCodeHash(address) {
      const bytecode = await client.getBytecode({ address })

      return bytecode ? keccak256(bytecode) : null
    },
    readContract,
  }
}
