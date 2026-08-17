import { DAI, NATIVE_CURRENCY_ADDRESS, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { assertTradeTokenPolicy, getTokenPolicyDecision } from './tokenPolicy'

describe('Ophis token policy', () => {
  it.each([NATIVE_CURRENCY_ADDRESS, WETH_MAINNET.address, USDC_MAINNET.address, DAI.address])(
    'allows reviewed Ethereum asset %s',
    (address) => {
      expect(getTokenPolicyDecision({ chainId: SupportedChainId.MAINNET, address })).toEqual({
        allowed: true,
        reason: 'approved',
      })
    },
  )

  it('fails closed for an unreviewed token and chain', () => {
    expect(
      getTokenPolicyDecision({
        chainId: SupportedChainId.MAINNET,
        address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      }),
    ).toEqual({ allowed: false, reason: 'token-not-reviewed' })
    expect(getTokenPolicyDecision({ chainId: 10, address: WETH_MAINNET.address })).toEqual({
      allowed: false,
      reason: 'chain-not-reviewed',
    })
  })

  it('rejects malformed policy inputs', () => {
    expect(getTokenPolicyDecision({ chainId: 1, address: 'not-an-address' })).toEqual({
      allowed: false,
      reason: 'invalid-token',
    })
    expect(getTokenPolicyDecision({ chainId: 0, address: WETH_MAINNET.address })).toEqual({
      allowed: false,
      reason: 'invalid-token',
    })
  })

  it('blocks signing when either side has not passed policy', () => {
    expect(() =>
      assertTradeTokenPolicy(
        { chainId: 1, address: WETH_MAINNET.address },
        { chainId: 1, address: USDC_MAINNET.address },
      ),
    ).not.toThrow()

    expect(() =>
      assertTradeTokenPolicy(
        { chainId: 1, address: WETH_MAINNET.address },
        { chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
      ),
    ).toThrow('token-not-reviewed')
  })
})
