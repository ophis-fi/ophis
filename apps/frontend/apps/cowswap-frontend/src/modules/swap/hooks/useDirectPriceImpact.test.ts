import { getDefaultStore } from 'jotai'

import { OrderKind } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { RwaTokenStatus, useRwaTokenStatus, useRwaConsentModalState } from 'modules/rwa'
import {
  TradeFormValidation,
  TradeFormValidationContext,
  tradeFormValidationContextAtom,
} from 'modules/tradeFormValidation'
import { useUsdAmount } from 'modules/usdAmount'

import { useConfirmationRequest } from 'common/hooks/useConfirmationRequest'
import { useConfirmPriceImpactWithoutFee } from 'common/hooks/useConfirmPriceImpactWithoutFee'

import { useDirectPriceImpact } from './useDirectPriceImpact'
import { useSwapDerivedState } from './useSwapDerivedState'

import { DirectQuote } from '../services/wholeToken/router.service'

jest.mock('modules/usdAmount', () => ({ useUsdAmount: jest.fn() }))
jest.mock('common/hooks/useConfirmPriceImpactWithoutFee', () => ({ useConfirmPriceImpactWithoutFee: jest.fn() }))
jest.mock('./useSwapDerivedState', () => ({ useSwapDerivedState: jest.fn() }))
jest.mock('@cowprotocol/tokens', () => ({ useIsTradeUnsupported: () => false }))
jest.mock('modules/tradeFormValidation', () => ({
  ...jest.requireActual('../../tradeFormValidation/types'),
  tradeFormValidationContextAtom: jest.requireActual('jotai').atom(null),
  validateTradeForm: jest.requireActual('../../tradeFormValidation/services/validateTradeForm').validateTradeForm,
}))
jest.mock('modules/rwa', () => ({
  RwaTokenStatus: { Allowed: 'Allowed', RequiredConsent: 'RequiredConsent' },
  useRwaTokenStatus: jest.fn(),
  useRwaConsentModalState: jest.fn(),
}))
jest.mock('common/hooks/useConfirmationRequest', () => ({ useConfirmationRequest: jest.fn() }))
const confirmUnknown = jest.fn()
const openModal = jest.fn()
beforeEach(() => {
  jest.clearAllMocks()
  getDefaultStore().set(tradeFormValidationContextAtom, {
    account: token.address,
    isOnline: true,
    isSupportedWallet: true,
    isBundlingSupported: null,
    tradeQuote: { isLoading: false },
    tradePriceImpact: {},
    derivedTradeState: {
      inputCurrency: usd,
      outputCurrency: token,
      inputCurrencyAmount: amount(100),
      inputCurrencyBalance: amount(1000),
      orderKind: OrderKind.SELL,
    },
  } as TradeFormValidationContext)
  jest.mocked(useRwaTokenStatus).mockReturnValue({ status: RwaTokenStatus.Allowed, rwaTokenInfo: null })
  jest.mocked(useRwaConsentModalState).mockReturnValue({ openModal } as ReturnType<typeof useRwaConsentModalState>)
  jest.mocked(useConfirmationRequest).mockReturnValue(confirmUnknown)
  jest.mocked(useUsdAmount).mockReturnValue({ value: undefined, isLoading: false })
  jest.mocked(useConfirmPriceImpactWithoutFee).mockReturnValue({
    confirmPriceImpactWithoutFee: jest.fn().mockResolvedValue(true),
    isConfirmed: false,
  })
  jest
    .mocked(useSwapDerivedState)
    .mockReturnValue({ inputCurrency: token, outputCurrency: token } as ReturnType<typeof useSwapDerivedState>)
})
const quote = { netCost: 4n, gasCost: 1n, fees: [{ amount: 1n }], buyAmount: 1n } as DirectQuote
const token = new Token(1, '0x96c645D3D3706f793Ef52C19bBACe441900eD47D', 0)
const usd = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6)
const amount = (value: number): CurrencyAmount<Token> => CurrencyAmount.fromRawAmount(usd, value)

test('uses actual quoted spend, and delegates high impact approval without bypassing rejection', async () => {
  const confirm = jest.fn().mockResolvedValue(false)
  jest
    .mocked(useConfirmPriceImpactWithoutFee)
    .mockReturnValue({ confirmPriceImpactWithoutFee: confirm, isConfirmed: false })
  jest
    .mocked(useSwapDerivedState)
    .mockReturnValue({ inputCurrency: token, outputCurrency: token } as ReturnType<typeof useSwapDerivedState>)
  jest
    .mocked(useUsdAmount)
    .mockReturnValueOnce({ value: amount(100), isLoading: false })
    .mockReturnValueOnce({ value: amount(80), isLoading: false })
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(jest.mocked(useUsdAmount).mock.calls[0][0]?.quotient.toString()).toBe('2')
  expect(result.current.impact?.toFixed(0)).toBe('20')
  expect(await result.current.confirm()).toBe(false)
  expect(confirm).toHaveBeenCalledWith(result.current.impact)
})

test.each([false, true])('unknown impact requires explicit confirmation: %s', async (accepted) => {
  confirmUnknown.mockResolvedValue(accepted)
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(await result.current.confirm()).toBe(accepted)
  expect(confirmUnknown).toHaveBeenCalledWith(expect.objectContaining({ title: 'Price impact unavailable' }))
})

test('required token consent opens the existing dialog and stops execution', async () => {
  jest.mocked(useRwaTokenStatus).mockReturnValue({
    status: RwaTokenStatus.RequiredConsent,
    rwaTokenInfo: { token, consentHash: 'consent', blockedCountries: new Set() },
  })
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(await result.current.confirm()).toBe(false)
  expect(openModal).toHaveBeenCalledWith(
    expect.objectContaining({ consentHash: 'consent', onImportSuccess: expect.any(Function) }),
  )
  expect(confirmUnknown).not.toHaveBeenCalled()
})

test('ordinary direct swaps do not wait for wallet bundling capabilities or cached fiat refresh', () => {
  jest
    .mocked(useUsdAmount)
    .mockReturnValueOnce({ value: amount(100), isLoading: true })
    .mockReturnValueOnce({ value: amount(99), isLoading: true })
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(result.current.allowed).toBe(true)
  expect(result.current.validation).toBeNull()
  expect(result.current.loading).toBe(false)
})

test('missing fiat remains loading until the first price is available', () => {
  jest.mocked(useUsdAmount).mockReturnValue({ value: undefined, isLoading: true })
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(result.current.loading).toBe(true)
})

test.each([
  [{ isTokenPolicyDenied: true }, TradeFormValidation.TokenPolicyDenied],
  [{ isOnline: false }, TradeFormValidation.BrowserOffline],
  [{ isRestrictedForCountry: true }, TradeFormValidation.RestrictedForCountry],
  [{ isProviderNetworkUnsupported: true }, TradeFormValidation.NetworkNotSupported],
  [{ isSafeReadonlyUser: true }, TradeFormValidation.SafeReadonlyUser],
  [
    { injectedWidgetParams: { disableTrade: { whenPriceImpactIsUnknown: true } } },
    TradeFormValidation.DisableTradeWithUnknownPriceImpact,
  ],
])('preserves the real validation blocker: %s', (overrides, validation) => {
  const store = getDefaultStore()
  const context = store.get(tradeFormValidationContextAtom)
  store.set(tradeFormValidationContextAtom, { ...context, ...overrides } as TradeFormValidationContext)
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(result.current.allowed).toBe(false)
  expect(result.current.validation).toBe(validation)
})

test('widget price-impact ceiling remains enforced during a cached fiat refresh', () => {
  const store = getDefaultStore()
  store.set(tradeFormValidationContextAtom, {
    ...store.get(tradeFormValidationContextAtom),
    injectedWidgetParams: { disableTrade: { whenPriceImpactIsHigherThan: 5 } },
  } as TradeFormValidationContext)
  jest
    .mocked(useUsdAmount)
    .mockReturnValueOnce({ value: amount(100), isLoading: true })
    .mockReturnValueOnce({ value: amount(80), isLoading: true })
  const { result } = renderHook(() => useDirectPriceImpact(quote))
  expect(result.current.allowed).toBe(false)
  expect(result.current.validation).toBe(TradeFormValidation.DisableTradeWithHighPriceImpact)
})
