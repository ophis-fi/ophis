import { ARC_CHAIN_ID, NATIVE_CURRENCY_ADDRESS, TokenWithLogo } from '@cowprotocol/common-const'

import { isBtcCctpSwap, WBTC_ETHEREUM } from './btcCctp.utils'
import { cctpAsset, cctpToken } from './cctpAssets.const'
import { cctpBuyTokens, cctpRouteAsset, hasCctpRoute } from './cctpRouting.utils'

jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))

const token = (chainId: number): TokenWithLogo =>
  TokenWithLogo.fromToken({
    chainId,
    address: cctpToken(chainId, 'cirBTC'),
    decimals: cctpAsset('cirBTC').decimals,
    symbol: 'cirBTC',
    name: 'Circle Wrapped Bitcoin',
  })

it('discovers the canonical Ethereum to Arc cirBTC route by destination address', () => {
  expect(cctpRouteAsset(token(1), token(5042))).toBe('cirBTC')
  const tokens = cctpBuyTokens({ sellChainId: 1, buyChainId: ARC_CHAIN_ID, sellTokenAddress: token(1).address })
  expect(tokens.map((item) => item.address)).toEqual([token(5042).address])
  expect(hasCctpRoute(5042, 1)).toBe(true)
  expect(cctpRouteAsset(token(5042), token(5042))).toBeUndefined()
  expect(hasCctpRoute(5042, 4663)).toBe(false)
})

it('rejects spoofed metadata, wrong-chain addresses and arbitrary custom contracts for bridging', () => {
  const spoof = TokenWithLogo.fromToken({
    ...token(5042),
    decimals: 18,
    symbol: 'cirBTC',
    name: 'Circle Wrapped Bitcoin',
  })
  expect(cctpRouteAsset(token(1), spoof)).toBeUndefined()
  const wrongChain = TokenWithLogo.fromToken({
    ...token(1),
    chainId: 5042,
    symbol: 'cirBTC',
    name: 'Circle Wrapped Bitcoin',
  })
  expect(cctpRouteAsset(token(1), wrongChain)).toBeUndefined()
  expect(
    cctpBuyTokens({
      sellChainId: 1,
      buyChainId: ARC_CHAIN_ID,
      sellTokenAddress: '0x0000000000000000000000000000000000000001',
    }),
  ).toEqual([])
})

it('never advertises CCTP assets for native ETH or an unsupported source asset', () => {
  expect(
    cctpBuyTokens({ sellChainId: 1, buyChainId: ARC_CHAIN_ID, sellTokenAddress: NATIVE_CURRENCY_ADDRESS }),
  ).toEqual([])
  expect(
    cctpBuyTokens({ sellChainId: 1, buyChainId: ARC_CHAIN_ID, sellTokenAddress: cctpToken(1, 'WETH') }).map(
      (t) => t.symbol,
    ),
  ).toEqual(['WETH'])
})

it('discovers WBTC conversion only for Ethereum to canonical Arc cirBTC, keeping it out of direct burn routes', () => {
  const wbtc = TokenWithLogo.fromToken({
    chainId: 1,
    address: WBTC_ETHEREUM,
    decimals: 8,
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
  })
  expect(
    cctpBuyTokens({ sellChainId: 1, buyChainId: ARC_CHAIN_ID, sellTokenAddress: wbtc.address }).map((t) => t.symbol),
  ).toEqual(['cirBTC'])
  expect(isBtcCctpSwap(wbtc, token(5042))).toBe(true)
  expect(cctpRouteAsset(wbtc, token(5042))).toBeUndefined()
  expect(
    isBtcCctpSwap(
      TokenWithLogo.fromToken({ ...wbtc, decimals: 18, symbol: 'WBTC', name: 'Wrapped Bitcoin' }),
      token(5042),
    ),
  ).toBe(false)
  expect(isBtcCctpSwap(wbtc, token(1))).toBe(false)
  expect(cctpBuyTokens({ sellChainId: 8453, buyChainId: ARC_CHAIN_ID, sellTokenAddress: wbtc.address })).toEqual([])
})
