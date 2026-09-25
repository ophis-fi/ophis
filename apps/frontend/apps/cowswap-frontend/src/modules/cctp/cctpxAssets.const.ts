import { type Address, type Hex } from 'viem'

import assets from './cctpxAssets.json'

// Static Circle mainnet registry snapshot, checked against CCTS/token contracts
// on every listed chain, 2026-09-25. Registry membership is not Circle issuance.
// Source: https://iris-api.circle.com/v2/cctpx/tokens?pageSize=150
// Smoke-test/duplicate MCCT entries are omitted. cctpx.test validates every entry.
export const CCTPX_ASSETS = assets as {
  readonly [Symbol in keyof typeof assets]: {
    homeChainId?: number
    tokenId: Hex
    manager: Address
    decimals: number
    addresses: Partial<Record<number, Address>>
  }
}
