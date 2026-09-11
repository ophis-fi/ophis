import { SUI_CHAIN_ID } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Fraction, Token } from '@cowprotocol/currency'

import { fetchCurrencyUsdPrice } from './fetchCurrencyUsdPrice'

import { getBffUsdPrice } from '../apis/getBffUsdPrice'
import { getCowProtocolUsdPrice } from '../apis/getCowProtocolUsdPrice'
import { getDefillamaUsdPrice } from '../apis/getDefillamaUsdPrice'

jest.mock('../apis/getBffUsdPrice', () => ({ getBffUsdPrice: jest.fn() }))
jest.mock('../apis/getCowProtocolUsdPrice', () => ({ getCowProtocolUsdPrice: jest.fn() }))
jest.mock('../apis/getDefillamaUsdPrice', () => ({
  DEFILLAMA_PLATFORMS: {},
  DEFILLAMA_RATE_LIMIT_TIMEOUT: 1000,
  getDefillamaUsdPrice: jest.fn(),
}))

const bff = getBffUsdPrice as jest.Mock
const defillama = getDefillamaUsdPrice as jest.Mock
const cow = getCowProtocolUsdPrice as jest.Mock

describe('fetchCurrencyUsdPrice on a chain without a CoW orderbook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    bff.mockRejectedValue(new Error('404'))
    defillama.mockRejectedValue(new Error('no platform'))
    cow.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'chainId')"))
  })

  it('ends at null for a bridge-only destination token instead of reaching the CoW source', async () => {
    const usdcOnSui = new Token(
      SUI_CHAIN_ID,
      '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
      6,
      'USDC',
    )
    await expect(fetchCurrencyUsdPrice(usdcOnSui)).resolves.toBeNull()
    expect(cow).not.toHaveBeenCalled()
    // Non-EVM ids are unknown to CoW's BFF: no request, no 404 log per token.
    expect(bff).not.toHaveBeenCalled()
  })

  it('still falls through to the CoW source on a supported chain', async () => {
    cow.mockResolvedValue(new Fraction(1, 1))
    const usdcMainnet = new Token(SupportedChainId.MAINNET, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC')
    await expect(fetchCurrencyUsdPrice(usdcMainnet)).resolves.toEqual(new Fraction(1, 1))
    expect(cow).toHaveBeenCalledTimes(1)
  })
})
