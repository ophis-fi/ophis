import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { RwaTokenStatus, useRwaTokenStatus, useRwaConsentModalState } from 'modules/rwa'
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
  tradeFormValidationContextAtom: jest.requireActual('jotai').atom({ tradePriceImpact: {} }),
  validateTradeForm: () => null,
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
