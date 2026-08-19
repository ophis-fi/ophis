import { DAI, NATIVE_CURRENCY_ADDRESS, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { getTokenPolicyDecision, TokenPolicyProfile } from '@cowprotocol/tokens'

import { getOtcTokenMeta, isOtcOrderDisplayReviewed, OTC_CURATED_TOKEN_COUNT } from './otcTokenMeta'

const ZAMM = '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED'

describe('getOtcTokenMeta', () => {
  it('returns curated metadata for the three escrow-reviewed tokens', () => {
    expect(getOtcTokenMeta(WETH_MAINNET.address)).toMatchObject({ symbol: 'WETH', decimals: 18, escrowRisks: [] })
    expect(getOtcTokenMeta(USDC_MAINNET.address)).toMatchObject({
      symbol: 'USDC',
      decimals: 6,
      escrowRisks: ['upgradeable', 'blacklistable'],
    })
    expect(getOtcTokenMeta(DAI.address)).toMatchObject({ symbol: 'DAI', decimals: 18, escrowRisks: [] })
  })

  it('is case-insensitive on lookup', () => {
    expect(getOtcTokenMeta(WETH_MAINNET.address.toLowerCase())?.symbol).toBe('WETH')
  })

  it('returns null for unreviewed tokens and the native sentinel', () => {
    expect(getOtcTokenMeta(ZAMM)).toBeNull()
    expect(getOtcTokenMeta(NATIVE_CURRENCY_ADDRESS)).toBeNull()
  })

  it('stays in exact agreement with the OTC_ESCROW token policy', () => {
    // The curated display set and the policy allowlist must not drift: every
    // curated token is escrow-approved, and the curated count matches the
    // policy's three-token allowlist.
    expect(OTC_CURATED_TOKEN_COUNT).toBe(3)
    for (const address of [WETH_MAINNET.address, USDC_MAINNET.address, DAI.address]) {
      expect(getOtcTokenMeta(address)).not.toBeNull()
      expect(getTokenPolicyDecision({ chainId: 1, address }, TokenPolicyProfile.OTC_ESCROW).allowed).toBe(true)
    }
    // and a policy-rejected token is never curated
    expect(getTokenPolicyDecision({ chainId: 1, address: ZAMM }, TokenPolicyProfile.OTC_ESCROW).allowed).toBe(false)
    expect(
      getTokenPolicyDecision({ chainId: 1, address: NATIVE_CURRENCY_ADDRESS }, TokenPolicyProfile.OTC_ESCROW).allowed,
    ).toBe(false)
  })
})

describe('isOtcOrderDisplayReviewed', () => {
  it('requires both legs to be curated', () => {
    expect(isOtcOrderDisplayReviewed({ tokenA: WETH_MAINNET.address, tokenB: USDC_MAINNET.address })).toBe(true)
    expect(isOtcOrderDisplayReviewed({ tokenA: ZAMM, tokenB: WETH_MAINNET.address })).toBe(false)
    expect(isOtcOrderDisplayReviewed({ tokenA: WETH_MAINNET.address, tokenB: ZAMM })).toBe(false)
  })
})
