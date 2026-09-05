import { AdditionalTargetChainId, isAdditionalTargetChain, SupportedChainId } from '@cowprotocol/cow-sdk'

import { isFlagGatedTargetChain } from './useSupportedTargetChains'

// Found 2026-08-27 while testing bridging from Robinhood Chain: Optimism was
// absent from the destination network picker for EVERY source chain. The cause
// was gating the destination list on isAdditionalTargetChain(), which is true for
// OPTIMISM as well as BITCOIN/SOLANA — upstream CoW does not trade on Optimism so
// it lives in AdditionalTargetChainId — meaning Optimism was dropped regardless
// of the BTC/Solana bridge feature flags.
describe('isFlagGatedTargetChain', () => {
  it('does NOT gate Optimism, even though it is an AdditionalTargetChainId', () => {
    // Guard the premise: if this ever becomes false the bug class is gone and
    // this test should be revisited rather than silently passing.
    expect(isAdditionalTargetChain(AdditionalTargetChainId.OPTIMISM)).toBe(true)

    expect(isFlagGatedTargetChain(AdditionalTargetChainId.OPTIMISM)).toBe(false)
  })

  it('gates exactly the two non-EVM chains that have bridge feature flags', () => {
    expect(isFlagGatedTargetChain(AdditionalTargetChainId.BITCOIN)).toBe(true)
    expect(isFlagGatedTargetChain(AdditionalTargetChainId.SOLANA)).toBe(true)
  })

  it('does not gate ordinary EVM destinations', () => {
    for (const id of [SupportedChainId.MAINNET, SupportedChainId.BASE, SupportedChainId.ARBITRUM_ONE]) {
      expect(isFlagGatedTargetChain(id)).toBe(false)
    }
  })
})
