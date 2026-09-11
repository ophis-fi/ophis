import { TokenWithLogo, USDC_MAINNET } from '@cowprotocol/common-const'
import { AdditionalTargetChainId, BTC_CURRENCY_ADDRESS, OrderKind } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'

import { useDerivedTradeState } from 'modules/trade'

import { useQuoteParams } from './useQuoteParams'
import { useQuoteParamsRecipient } from './useQuoteParamsRecipient'

jest.mock('@cowprotocol/common-hooks', () => ({
  ...jest.requireActual('@cowprotocol/common-hooks'),
  useDebounce: (value: unknown) => value,
}))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111' }),
}))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => ({ getSigner: jest.fn() }) }))
jest.mock('modules/appData', () => ({ useAppData: () => undefined }))
jest.mock('modules/trade', () => ({ useDerivedTradeState: jest.fn(), useIsWrapOrUnwrap: () => false }))
jest.mock('modules/tradeSlippage', () => ({ useTradeSlippageValueAndType: () => ({ type: 'user', value: 50 }) }))
jest.mock('modules/volumeFee', () => ({ useVolumeFee: () => undefined }))
jest.mock('common/hooks/useIsProviderNetworkDeprecated', () => ({ useIsProviderNetworkDeprecated: () => false }))
jest.mock('common/hooks/useIsProviderNetworkUnsupported', () => ({ useIsProviderNetworkUnsupported: () => false }))
jest.mock('./useQuoteParamsRecipient', () => ({ useQuoteParamsRecipient: jest.fn() }))

it.each([
  [AdditionalTargetChainId.SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  [AdditionalTargetChainId.BITCOIN, BTC_CURRENCY_ADDRESS],
] as const)('never requests a quote with an implicit EVM owner for destination %s', (chainId, address) => {
  const state: Partial<ReturnType<typeof useDerivedTradeState>> = {
    inputCurrency: USDC_MAINNET,
    outputCurrency: new TokenWithLogo(undefined, chainId, address, 6),
    orderKind: OrderKind.SELL,
  }
  jest.mocked(useDerivedTradeState).mockReturnValue(state as ReturnType<typeof useDerivedTradeState>)
  jest.mocked(useQuoteParamsRecipient).mockReturnValue(undefined)

  const { result, rerender } = renderHook(() => useQuoteParams('1000000'))
  expect(result.current).toBeUndefined()

  jest.mocked(useQuoteParamsRecipient).mockReturnValue(address)
  rerender()
  expect(result.current?.quoteParams).toEqual(expect.objectContaining({ receiver: address, buyTokenChainId: chainId }))
})

it('never requests a partially fillable quote for a bridge order (fill-or-kill: the deposit is quoted on the full amount)', () => {
  const bridge: Partial<ReturnType<typeof useDerivedTradeState>> = {
    inputCurrency: USDC_MAINNET,
    outputCurrency: new TokenWithLogo(
      undefined,
      AdditionalTargetChainId.SOLANA,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      6,
    ),
    orderKind: OrderKind.SELL,
  }
  jest.mocked(useDerivedTradeState).mockReturnValue(bridge as ReturnType<typeof useDerivedTradeState>)
  jest.mocked(useQuoteParamsRecipient).mockReturnValue('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  const { result: bridged } = renderHook(() => useQuoteParams('1000000', true))
  expect(bridged.current?.quoteParams?.partiallyFillable).toBe(false)

  const sameChain: Partial<ReturnType<typeof useDerivedTradeState>> = {
    inputCurrency: USDC_MAINNET,
    outputCurrency: new TokenWithLogo(undefined, USDC_MAINNET.chainId, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    orderKind: OrderKind.SELL,
  }
  jest.mocked(useDerivedTradeState).mockReturnValue(sameChain as ReturnType<typeof useDerivedTradeState>)
  jest.mocked(useQuoteParamsRecipient).mockReturnValue(undefined)
  const { result: local } = renderHook(() => useQuoteParams('1000000', true))
  expect(local.current?.quoteParams?.partiallyFillable).toBe(true)
})
