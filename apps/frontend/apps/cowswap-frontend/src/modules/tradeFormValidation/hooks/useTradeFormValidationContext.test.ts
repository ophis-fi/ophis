import { useCurrencyAmountBalance } from '@cowprotocol/balances-and-allowances'
import {
  NATIVE_CURRENCIES,
  STARKNET_CHAIN_ID,
  USDC_MAINNET,
  WRAPPED_NATIVE_CURRENCIES,
} from '@cowprotocol/common-const'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { CurrencyAmount } from '@cowprotocol/currency'
import { BridgeQuoteResults } from '@cowprotocol/sdk-bridging'
import { useIsTxBundlingSupported } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'

import { TradeType, useDerivedTradeState, useIsSwapEth, useSwapFundingAmount } from 'modules/trade'
import type { TradeQuoteState } from 'modules/tradeQuote'

import { useTradeFormValidationContext } from './useTradeFormValidationContext'

import { validateTradeForm } from '../services/validateTradeForm'
import { TradeFormValidation } from '../types'

let mockQuote: Partial<TradeQuoteState> = {}
let mockProxy: {
  isLoading: boolean
  data?: { isProxySetupValid: boolean | null }
  error?: Error
} = { isLoading: false }

beforeEach(() => {
  mockQuote = {}
  mockProxy = { isLoading: false }
})

jest.mock('@cowprotocol/balances-and-allowances', () => ({ useCurrencyAmountBalance: jest.fn() }))
jest.mock('@cowprotocol/common-hooks', () => ({ useIsOnline: () => true }))
jest.mock('@cowprotocol/tokens', () => ({
  isTradeAllowedByTokenPolicy: () => true,
  TokenPolicyProfile: {},
  useIsTradeUnsupported: () => false,
  useIsXstockToken: () => false,
  useTryFindToken: () => ({}),
}))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111' }),
  useGnosisSafeInfo: () => null,
  useIsTxBundlingSupported: jest.fn(),
  useWalletDetails: () => ({ isSupportedWallet: true }),
}))
jest.mock('entities/bridgeProvider', () => ({ useHasHookBridgeProvidersEnabled: () => true }))
jest.mock('modules/accountProxy', () => ({ useCurrentAccountProxy: () => mockProxy }))
jest.mock('modules/combinedBalances', () => ({ useTokensBalancesCombined: () => ({ hasFirstLoad: true }) }))
jest.mock('modules/erc20Approve', () => ({
  useApproveState: () => ({}),
  useGetAmountToSignApprove: () => null,
  useIsApprovalOrPermitRequired: () => ({}),
}))
jest.mock('modules/injectedWidget', () => ({ useInjectedWidgetParams: () => ({}) }))
jest.mock('modules/rwa', () => ({ RwaTokenStatus: { Restricted: 'restricted' }, useRwaTokenStatus: () => ({}) }))
jest.mock('modules/trade', () => ({
  TradeType: { SWAP: 'swap' },
  useDerivedTradeState: jest.fn(),
  useIsWrapOrUnwrap: () => false,
  useIsSwapEth: jest.fn(),
  useIsHooksTradeType: () => false,
  useWrappedToken: () => jest.requireActual('@cowprotocol/common-const').WRAPPED_NATIVE_CURRENCIES[1],
  useSwapFundingAmount: jest.fn(),
  useTradePriceImpact: () => ({}),
}))
jest.mock('modules/tradeQuote', () => ({ useTradeQuote: () => mockQuote }))
jest.mock('common/hooks/useIsProviderNetworkDeprecated', () => ({ useIsProviderNetworkDeprecated: () => false }))
jest.mock('common/hooks/useIsProviderNetworkUnsupported', () => ({ useIsProviderNetworkUnsupported: () => false }))
jest.mock('common/hooks/useOphisNameResolution', () => ({ useOphisNameResolution: () => ({}) }))
jest.mock('./useTokenCustomTradeError', () => ({ useTokenCustomTradeError: () => undefined }))

it.each<[boolean, boolean, string, string]>([
  [true, false, '0', '1010'],
  [true, false, '1005', '1000'],
  [true, true, '0', '1000'],
  [false, false, '0', '1000'],
])(
  'validates the actual funding requirement: native=%s, bundled=%s, WETH=%s',
  (isNative, bundled, wethAtoms, required) => {
    const native = NATIVE_CURRENCIES[1]
    const cap = CurrencyAmount.fromRawAmount(native, '1000')
    const buffered = CurrencyAmount.fromRawAmount(native, '1010')
    const balance = CurrencyAmount.fromRawAmount(native, '1005')
    const wrappedBalance = CurrencyAmount.fromRawAmount(WRAPPED_NATIVE_CURRENCIES[1], wethAtoms)
    jest.mocked(useCurrencyAmountBalance).mockReturnValue(wrappedBalance)
    jest.mocked(useIsSwapEth).mockReturnValue(isNative)
    jest.mocked(useIsTxBundlingSupported).mockReturnValue(bundled)
    jest.mocked(useSwapFundingAmount).mockImplementation((buffer) => (buffer ? buffered : cap))
    jest.mocked(useDerivedTradeState).mockReturnValue({
      inputCurrency: native,
      outputCurrency: USDC_MAINNET,
      inputCurrencyAmount: cap,
      inputCurrencyBalance: balance,
      orderKind: OrderKind.BUY,
      tradeType: TradeType.SWAP,
    } as unknown as ReturnType<typeof useDerivedTradeState>)
    const { result } = renderHook(() => useTradeFormValidationContext())
    const state = result.current?.derivedTradeState
    expect(state?.inputCurrencyAmount?.quotient.toString()).toBe(required)
    expect(state?.inputCurrencyBalance?.lessThan(state.inputCurrencyAmount ?? cap)).toBe(
      isNative && !bundled && wethAtoms === '0',
    )
  },
)

describe('bridge account-proxy validation', () => {
  beforeEach(() => {
    const native = NATIVE_CURRENCIES[8453]
    const amount = CurrencyAmount.fromRawAmount(native, '50000000000000000')
    jest.mocked(useIsSwapEth).mockReturnValue(true)
    jest.mocked(useIsTxBundlingSupported).mockReturnValue(true)
    jest.mocked(useSwapFundingAmount).mockReturnValue(amount)
    jest.mocked(useDerivedTradeState).mockReturnValue({
      inputCurrency: native,
      outputCurrency: NATIVE_CURRENCIES[STARKNET_CHAIN_ID],
      inputCurrencyAmount: amount,
      inputCurrencyBalance: amount,
      orderKind: OrderKind.SELL,
      tradeType: TradeType.SWAP,
    } as unknown as ReturnType<typeof useDerivedTradeState>)
  })

  it.each([true, false])('NEAR Base-to-Starknet ignores unrelated proxy loading/failure: loading=%s', (isLoading) => {
    mockQuote.bridgeQuote = {
      providerInfo: { type: 'ReceiverAccountBridgeProvider' },
    } as BridgeQuoteResults
    mockProxy = { isLoading, error: new Error('unrelated account-proxy RPC failure') }
    const { result } = renderHook(() => useTradeFormValidationContext())
    expect(result.current).toMatchObject({ isAccountProxyLoading: false, isProxySetupValid: true })
    expect(result.current && validateTradeForm(result.current)).not.toContain(TradeFormValidation.ProxyAccountLoading)
  })

  it('still waits for the account proxy when the selected bridge uses hooks', () => {
    mockQuote.bridgeQuote = { providerInfo: { type: 'HookBridgeProvider' } } as BridgeQuoteResults
    mockProxy = { isLoading: true }
    const { result } = renderHook(() => useTradeFormValidationContext())
    expect(result.current).toMatchObject({ isAccountProxyLoading: true })
    expect(result.current && validateTradeForm(result.current)).toContain(TradeFormValidation.ProxyAccountLoading)
  })

  it.each([true, false, null])('preserves hook proxy verification state: %s', (isProxySetupValid) => {
    mockQuote.bridgeQuote = { providerInfo: { type: 'HookBridgeProvider' } } as BridgeQuoteResults
    mockProxy = { isLoading: false, data: { isProxySetupValid } }
    const { result } = renderHook(() => useTradeFormValidationContext())
    expect(result.current).toMatchObject({ isAccountProxyLoading: false, isProxySetupValid })
  })

  it.each([false, true])('reports a hook proxy RPC failure even while retrying: loading=%s', (isLoading) => {
    mockQuote.bridgeQuote = { providerInfo: { type: 'HookBridgeProvider' } } as BridgeQuoteResults
    mockProxy = { isLoading, error: new Error('proxy RPC unavailable') }
    const { result } = renderHook(() => useTradeFormValidationContext())
    expect(result.current).toMatchObject({ isAccountProxyLoading: false, isProxySetupValid: null })
    expect(result.current && validateTradeForm(result.current)).toContain(TradeFormValidation.ProxyAccountUnknown)
  })
})
