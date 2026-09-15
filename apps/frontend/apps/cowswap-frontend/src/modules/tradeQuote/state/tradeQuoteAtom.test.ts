import { createStore, PrimitiveAtom } from 'jotai'

import { AdditionalTargetChainId, BTC_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'
import { BridgeProviderQuoteError, BridgeQuoteErrors } from '@cowprotocol/sdk-bridging'

import { derivedTradeStateAtom } from 'modules/trade/state/derivedTradeStateAtom'
import { shouldHideQuoteAmountsAtom } from 'modules/trade/state/shouldHideQuoteAmounts.atom'
import type { TradeDerivedState } from 'modules/trade/types'

import { currentTradeQuoteAtom, DEFAULT_TRADE_QUOTE_STATE, tradeQuotesAtom, TradeQuoteState } from './tradeQuoteAtom'

jest.mock('modules/trade/state/derivedTradeStateAtom', () => ({
  derivedTradeStateAtom: jest.requireActual<typeof import('jotai')>('jotai').atom(null),
}))
jest.mock('entities/common/isProviderNetworkDeprecated.atom', () => ({
  isProviderNetworkDeprecatedAtom: jest.requireActual<typeof import('jotai')>('jotai').atom(false),
}))
jest.mock('modules/tradeQuote', () => jest.requireActual('./tradeQuoteAtom'))

const EVM_TOKEN = new Token(1, '0x1234567890123456789012345678901234567890', 6)
const SOL_TOKEN = new Token(AdditionalTargetChainId.SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6)
const RECIPIENT = 'So11111111111111111111111111111111111111112'
const stateAtom = derivedTradeStateAtom as PrimitiveAtom<TradeDerivedState | null>
const QUOTE: TradeQuoteState = {
  ...DEFAULT_TRADE_QUOTE_STATE,
  quote: { quoteResults: { tradeParameters: { sellToken: EVM_TOKEN.address } } },
  bridgeQuote: {
    tradeParameters: {
      sellTokenChainId: 1,
      sellTokenAddress: '0x9876543210987654321098765432109876543210',
      buyTokenChainId: SOL_TOKEN.chainId,
      buyTokenAddress: SOL_TOKEN.address,
      receiver: RECIPIENT,
    },
  },
} as TradeQuoteState

function setup(state: Partial<TradeDerivedState> = {}, quote: TradeQuoteState = QUOTE): ReturnType<typeof createStore> {
  const store = createStore()
  store.set(stateAtom, {
    inputCurrency: EVM_TOKEN,
    outputCurrency: SOL_TOKEN,
    recipient: RECIPIENT,
    ...state,
  } as TradeDerivedState)
  store.set(tradeQuotesAtom, { [EVM_TOKEN.address]: quote })
  return store
}

it.each([null, '', EVM_TOKEN.address, BTC_CURRENCY_ADDRESS])(
  'clears stale amounts immediately when the Solana recipient is invalid: %s',
  (recipient) => {
    const store = setup({ recipient })
    expect(store.get(currentTradeQuoteAtom)).toBe(DEFAULT_TRADE_QUOTE_STATE)
    expect(store.get(shouldHideQuoteAmountsAtom)).toBe(true)
  },
)

it('hides an earlier EVM swap after selecting a non-EVM destination', () => {
  const previousQuote = { ...QUOTE, bridgeQuote: null }
  const store = setup({ outputCurrency: EVM_TOKEN }, previousQuote)
  expect(store.get(currentTradeQuoteAtom)).toBe(previousQuote)

  store.set(stateAtom, { ...store.get(stateAtom), outputCurrency: SOL_TOKEN } as TradeDerivedState)
  expect(store.get(currentTradeQuoteAtom)).toEqual({
    ...previousQuote,
    quote: null,
    bridgeQuote: null,
    isBridgeQuote: null,
    localQuoteTimestamp: null,
    isStaleDestination: true,
  })
  expect(store.get(shouldHideQuoteAmountsAtom)).toBe(true)
})

it.each([
  { buyTokenChainId: AdditionalTargetChainId.BITCOIN },
  { sellTokenChainId: 10 },
  { buyTokenAddress: SOL_TOKEN.address.toLowerCase() },
  { buyTokenAddress: RECIPIENT },
  { receiver: SOL_TOKEN.address },
  { receiver: undefined },
  { bridgeRecipient: SOL_TOKEN.address },
])('hides stale bridge token/chain/recipient amounts: %j', (changes) => {
  const bridgeQuote = QUOTE.bridgeQuote
  if (!bridgeQuote) throw new Error('Missing fixture')
  const store = setup(
    {},
    {
      ...QUOTE,
      bridgeQuote: { ...bridgeQuote, tradeParameters: { ...bridgeQuote.tradeParameters, ...changes } },
    },
  )
  expect(store.get(currentTradeQuoteAtom).quote).toBeNull()
  expect(store.get(currentTradeQuoteAtom).bridgeQuote).toBeNull()
  expect(store.get(shouldHideQuoteAmountsAtom)).toBe(true)
})

it('hides an old source-token quote while preserving its current request loading/error', () => {
  const error = new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES)
  const quote = QUOTE.quote
  if (!quote) throw new Error('Missing fixture')
  const store = setup(
    {},
    {
      ...QUOTE,
      isLoading: true,
      error,
      quote: {
        ...quote,
        quoteResults: {
          ...quote.quoteResults,
          tradeParameters: { ...quote.quoteResults.tradeParameters, sellToken: RECIPIENT },
        },
      },
    },
  )
  expect(store.get(currentTradeQuoteAtom)).toMatchObject({ quote: null, bridgeQuote: null, isLoading: true, error })
})

it('preserves a current quote with a different bridge intermediate token', () => {
  const store = setup()
  expect(store.get(currentTradeQuoteAtom)).toBe(QUOTE)
  expect(store.get(shouldHideQuoteAmountsAtom)).toBe(false)
})

it('leaves EVM quote behavior unchanged', () => {
  const evmQuote = { ...QUOTE, bridgeQuote: null }
  const store = setup({ outputCurrency: EVM_TOKEN, recipient: null }, evmQuote)
  expect(store.get(currentTradeQuoteAtom)).toBe(evmQuote)
  expect(store.get(shouldHideQuoteAmountsAtom)).toBe(false)
})

it('hides non-EVM amounts when switching back to EVM until the new quote arrives', () => {
  const store = setup()
  expect(store.get(currentTradeQuoteAtom)).toBe(QUOTE)

  store.set(stateAtom, { ...store.get(stateAtom), outputCurrency: EVM_TOKEN, recipient: null } as TradeDerivedState)
  expect(store.get(currentTradeQuoteAtom)).toMatchObject({
    quote: null,
    bridgeQuote: null,
    isLoading: false,
    isStaleDestination: true,
  })
  expect(store.get(shouldHideQuoteAmountsAtom)).toBe(true)

  const evmQuote = { ...QUOTE, bridgeQuote: null }
  store.set(tradeQuotesAtom, { [EVM_TOKEN.address]: evmQuote })
  expect(store.get(currentTradeQuoteAtom)).toBe(evmQuote)
  expect(store.get(shouldHideQuoteAmountsAtom)).toBe(false)
})
