import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { PriceQuality, QuoteAndPost } from '@cowprotocol/cow-sdk'

import type { useTradeQuote } from 'modules/tradeQuote'

import { DirectQuote, MPS, USDC } from './router.service'
import { canFundDirect, comparisonLoading, selectDirect } from './selection.service'

const direct = {
  inputToken: USDC,
  buyAmount: 1n,
  netCost: 9n,
  budget: 10n,
  quotedAt: 1000,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 0n,
} as DirectQuote
function cowQuote(input = USDC): ReturnType<typeof useTradeQuote> {
  return {
    quote: {
      quoteResults: {
        tradeParameters: { sellToken: input, buyToken: MPS, amount: '10' },
        amountsAndCosts: { afterPartnerFees: { buyAmount: 1n }, amountsToSign: { sellAmount: 8n } },
      },
    } as unknown as QuoteAndPost,
    error: null,
    hasParamsChanged: false,
    isLoading: true,
    fetchParams: { hasParamsChanged: false, priceQuality: PriceQuality.OPTIMAL, fetchStartTimestamp: 1 },
    isBridgeQuote: false,
    bridgeQuote: null,
    localQuoteTimestamp: 1,
  }
}

it('keeps a better current CoW quote during background refresh', () => {
  const cow = cowQuote()
  expect(selectDirect(direct, cow, 1001, 0n)).toBeUndefined()
  expect(selectDirect(direct, { ...cow, isLoading: false }, 1001, 0n)).toBeUndefined()
})

it('waits for native deposit gas and compares both complete costs', () => {
  const cow = cowQuote(NATIVE_CURRENCY_ADDRESS)
  const native = { ...direct, inputToken: undefined }
  expect(comparisonLoading('current', false, false, cow, true)).toBe(true)
  expect(comparisonLoading('current', false, false, cow, false)).toBe(false)
  expect(selectDirect(native, cow, 1001, 2n)).toBe(native)
})

it('uses the available direct quote when CoW still belongs to a different form', () => {
  expect(selectDirect(direct, { ...cowQuote(), hasParamsChanged: true }, 1001, 0n)).toBe(direct)
  expect(selectDirect(direct, cowQuote(NATIVE_CURRENCY_ADDRESS), 1001, 0n)).toBe(direct)
  expect(selectDirect(direct, cowQuote(), 31000, 0n)).toBeUndefined()
})

it('waits for an initial optimal CoW quote before making direct review available', () => {
  const cow = cowQuote()
  expect(comparisonLoading('current', false, false, { ...cow, quote: null }, false)).toBe(true)
  expect(
    comparisonLoading(
      'current',
      false,
      false,
      { ...cow, fetchParams: { hasParamsChanged: false, fetchStartTimestamp: 1, priceQuality: PriceQuality.FAST } },
      false,
    ),
  ).toBe(true)
  expect(comparisonLoading('current', false, false, cow, false)).toBe(false)
})

it('keeps gasless CoW available when USDC users cannot fund direct gas and approvals', () => {
  const usdc = { ...direct, gasLimit: 120n, approvalGas: 100n }
  expect(canFundDirect(usdc, true, undefined)).toBe(false)
  expect(canFundDirect(usdc, true, 0n)).toBe(false)
  expect(canFundDirect(usdc, true, 479n)).toBe(false)
  expect(canFundDirect(usdc, true, 480n)).toBe(true)
  expect(canFundDirect(usdc, false, undefined)).toBe(true)
})
