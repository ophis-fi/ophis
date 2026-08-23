import { DAI, NATIVE_CURRENCY_ADDRESS, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { assertTradeTokenPolicy, getTokenPolicyDecision, TokenPolicyProfile } from './tokenPolicy'

const PINNED_OTC_ASSETS = [
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
] as const

describe('Ophis token policy', () => {
  it('preserves valid tokens on established settlement chains', () => {
    expect(
      getTokenPolicyDecision(
        {
          chainId: SupportedChainId.MAINNET,
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        },
        TokenPolicyProfile.ESTABLISHED_SETTLEMENT,
      ),
    ).toEqual({ allowed: true, reason: 'approved' })
  })

  it.each([1, 10, 56, 100, 130, 137, 4_663, 8_453, 9_745, 42_161, 43_114, 57_073, 59_144])(
    'keeps chain %s available under established settlement',
    (chainId) => {
      expect(
        getTokenPolicyDecision({ chainId, address: WETH_MAINNET.address }, TokenPolicyProfile.ESTABLISHED_SETTLEMENT),
      ).toEqual({
        allowed: true,
        reason: 'approved',
      })
    },
  )

  it.each([NATIVE_CURRENCY_ADDRESS, WETH_MAINNET.address, USDC_MAINNET.address, DAI.address])(
    'allows reviewed Ethereum asset %s under restricted execution',
    (address) => {
      expect(
        getTokenPolicyDecision({ chainId: SupportedChainId.MAINNET, address }, TokenPolicyProfile.RESTRICTED_EXECUTION),
      ).toEqual({ allowed: true, reason: 'approved' })
    },
  )

  it('fails closed for an unreviewed restricted-execution token and chain', () => {
    expect(
      getTokenPolicyDecision(
        {
          chainId: SupportedChainId.MAINNET,
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        },
        TokenPolicyProfile.RESTRICTED_EXECUTION,
      ),
    ).toEqual({ allowed: false, reason: 'token-not-reviewed' })
    expect(
      getTokenPolicyDecision({ chainId: 10, address: WETH_MAINNET.address }, TokenPolicyProfile.RESTRICTED_EXECUTION),
    ).toEqual({ allowed: false, reason: 'chain-not-reviewed' })
    expect(
      getTokenPolicyDecision(
        { chainId: 999_999, address: WETH_MAINNET.address },
        TokenPolicyProfile.ESTABLISHED_SETTLEMENT,
      ),
    ).toEqual({ allowed: false, reason: 'chain-not-reviewed' })
  })
})

describe('Ophis token policy — OTC escrow profile', () => {
  it('pins the shared constants to the independently reviewed escrow addresses', () => {
    expect([WETH_MAINNET.address, USDC_MAINNET.address, DAI.address]).toEqual(PINNED_OTC_ASSETS)
  })

  it.each(PINNED_OTC_ASSETS)('allows reviewed Ethereum escrow asset %s under the OTC escrow profile', (address) => {
    expect(
      getTokenPolicyDecision({ chainId: SupportedChainId.MAINNET, address }, TokenPolicyProfile.OTC_ESCROW),
    ).toEqual({ allowed: true, reason: 'approved' })
  })

  it('fails closed for the OTC escrow profile outside its exact allowlist', () => {
    // Native ETH is exposed only through the escrow contract's reviewed WETH
    // convenience functions, so the raw native sentinel is not escrow-approved.
    expect(
      getTokenPolicyDecision(
        { chainId: SupportedChainId.MAINNET, address: NATIVE_CURRENCY_ADDRESS },
        TokenPolicyProfile.OTC_ESCROW,
      ),
    ).toEqual({ allowed: false, reason: 'token-not-reviewed' })
    expect(
      getTokenPolicyDecision(
        { chainId: SupportedChainId.MAINNET, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
        TokenPolicyProfile.OTC_ESCROW,
      ),
    ).toEqual({ allowed: false, reason: 'token-not-reviewed' })
    expect(
      getTokenPolicyDecision({ chainId: 10, address: WETH_MAINNET.address }, TokenPolicyProfile.OTC_ESCROW),
    ).toEqual({ allowed: false, reason: 'chain-not-reviewed' })
  })
})

describe('Ophis token policy — shared input handling', () => {
  it('rejects malformed policy inputs', () => {
    expect(
      getTokenPolicyDecision({ chainId: 1, address: 'not-an-address' }, TokenPolicyProfile.ESTABLISHED_SETTLEMENT),
    ).toEqual({ allowed: false, reason: 'invalid-token' })
    expect(
      getTokenPolicyDecision({ chainId: 0, address: WETH_MAINNET.address }, TokenPolicyProfile.ESTABLISHED_SETTLEMENT),
    ).toEqual({ allowed: false, reason: 'invalid-token' })
  })

  it('blocks signing when either side has not passed policy', () => {
    expect(() =>
      assertTradeTokenPolicy(
        { chainId: 1, address: WETH_MAINNET.address },
        { chainId: 1, address: USDC_MAINNET.address },
        TokenPolicyProfile.RESTRICTED_EXECUTION,
      ),
    ).not.toThrow()

    expect(() =>
      assertTradeTokenPolicy(
        { chainId: 1, address: WETH_MAINNET.address },
        { chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
        TokenPolicyProfile.RESTRICTED_EXECUTION,
      ),
    ).toThrow('token-not-reviewed')
  })
})
