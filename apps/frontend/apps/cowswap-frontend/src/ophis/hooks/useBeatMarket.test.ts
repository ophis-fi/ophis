import { CurrencyAmount, Token } from '@cowprotocol/currency'

import type { ReceiveAmountInfo } from 'modules/trade'

import { buildBeatMarketRequest } from './useBeatMarket'

const USDC = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC')
const WETH = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH')
const USDG_ROBINHOOD = new Token(4663, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, 'USDG')

const sellInfo = (buy: Token): ReceiveAmountInfo =>
  ({
    isSell: true,
    afterNetworkCosts: {
      sellAmount: CurrencyAmount.fromRawAmount(USDC, '100000000'),
      buyAmount: CurrencyAmount.fromRawAmount(buy, '1'),
    },
  }) as unknown as ReceiveAmountInfo

describe('buildBeatMarketRequest', () => {
  it('builds a same-chain reference request', () => {
    expect(buildBeatMarketRequest(sellInfo(WETH))).toMatchObject({
      chainId: 1,
      sellToken: USDC.address,
      buyToken: WETH.address,
      sellAmount: '100000000',
    })
  })

  it('asks for no reference on a bridge trade (buy token on another chain)', () => {
    // Sending the destination-chain address to the sell chain's aggregator only
    // produced "token not found" -> 502 in every bridge session.
    expect(buildBeatMarketRequest(sellInfo(USDG_ROBINHOOD))).toBeNull()
  })
})
