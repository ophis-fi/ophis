import { useCurrencyAmountBalance } from '@cowprotocol/balances-and-allowances'
import { NATIVE_CURRENCIES, USDC_MAINNET, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { CurrencyAmount } from '@cowprotocol/currency'
import { useIsTxBundlingSupported } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'

import { TradeType, useDerivedTradeState, useIsSwapEth, useSwapFundingAmount } from 'modules/trade'

import { useTradeFormValidationContext } from './useTradeFormValidationContext'

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
jest.mock('entities/bridgeProvider', () => ({ useHasHookBridgeProvidersEnabled: () => false }))
jest.mock('modules/accountProxy/hooks/useCurrentAccountProxy', () => ({ useCurrentAccountProxy: () => ({}) }))
jest.mock('modules/combinedBalances', () => ({ useTokensBalancesCombined: () => ({ hasFirstLoad: true }) }))
jest.mock('modules/erc20Approve', () => ({
  useApproveState: () => ({}),
  useGetAmountToSignApprove: () => null,
  useIsApprovalOrPermitRequired: () => ({}),
}))
jest.mock('modules/injectedWidget', () => ({ useInjectedWidgetParams: () => ({}) }))
jest.mock('modules/rwa', () => ({ RwaTokenStatus: {}, useRwaTokenStatus: () => ({}) }))
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
jest.mock('modules/tradeQuote', () => ({ useTradeQuote: () => ({}) }))
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
