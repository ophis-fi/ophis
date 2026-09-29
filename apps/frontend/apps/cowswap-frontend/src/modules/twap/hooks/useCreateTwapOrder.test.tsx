import { act, renderHook, waitFor } from '@testing-library/react'

import { useCreateTwapOrder } from './useCreateTwapOrder'

const mockSend = jest.fn()
const mockEnroll = jest.fn().mockResolvedValue(true)
const mockAddOrder = jest.fn()
const mockOnError = jest.fn()
const account = '0x1111111111111111111111111111111111111111'

jest.mock('jotai', () => ({ useSetAtom: () => mockAddOrder }))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ chainId: 1, account }),
  useIsSmartContractWallet: () => true,
  useSendBatchTransactions: () => mockSend,
}))
jest.mock('@cowprotocol/analytics', () => ({
  __resetGtmInstance: jest.fn(),
  useCowAnalytics: () => ({ sendEvent: jest.fn() }),
}))
jest.mock('@cowprotocol/tokens', () => ({ assertTradeTokenPolicy: jest.fn(), TokenPolicyProfile: {} }))
jest.mock('modules/advancedOrders', () => ({
  useAdvancedOrdersDerivedState: () => ({
    inputCurrencyAmount: { currency: { chainId: 1, wrapped: { address: account }, symbol: 'USDC' } },
    outputCurrencyAmount: { currency: { chainId: 1, wrapped: { address: account }, symbol: 'WETH' } },
  }),
  useUpdateAdvancedOrdersRawState: () => jest.fn(),
}))
jest.mock('modules/appData', () => ({ uploadAppDataDocOrderbookApi: jest.fn(), useAppData: () => ({}) }))
jest.mock('modules/injectedWidget', () => ({
  buildTradeWidgetHookPayload: jest.fn(),
  callWidgetHook: async () => true,
}))
jest.mock('modules/orders', () => ({ emitPostedOrderEvent: jest.fn() }))
jest.mock('modules/ordersTable', () => ({ OrderTabId: {}, useNavigateToOrdersTableTab: () => jest.fn() }))
jest.mock('modules/sounds', () => ({ getCowSoundSend: () => ({ play: jest.fn() }) }))
jest.mock('modules/trade', () => ({
  useTradeConfirmActions: () => ({ onSign: jest.fn(), onSuccess: jest.fn(), onError: mockOnError }),
  useTradePriceImpact: () => ({}),
}))
jest.mock('modules/trade/utils/tradeFlowAnalytics', () => ({
  useTradeFlowAnalytics: () => ({ placeAdvancedOrder: jest.fn(), sign: jest.fn(), error: jest.fn() }),
}))
jest.mock('common/hooks/useConfirmPriceImpactWithoutFee', () => ({
  useConfirmPriceImpactWithoutFee: () => ({ confirmPriceImpactWithoutFee: async () => true }),
}))
jest.mock('common/hooks/useVerifyOphisRecipientName', () => ({ useVerifyOphisRecipientName: () => jest.fn() }))
jest.mock('common/utils/getAreBridgeCurrencies', () => ({ getAreBridgeCurrencies: () => false }))
jest.mock('common/utils/enrollOphisTrader', () => ({ enrollOphisTrader: (owner: string) => mockEnroll(owner) }))
jest.mock('./useExtensibleFallbackContext', () => ({ useExtensibleFallbackContext: () => ({}) }))
jest.mock('./useTwapOrder', () => ({
  useTwapOrder: () => ({ receiver: '0x2222222222222222222222222222222222222222' }),
}))
jest.mock('./useTwapOrderCreationContext', () => ({ useTwapOrderCreationContext: () => ({ chainId: 1 }) }))
jest.mock('../services/createTwapOrderTxs', () => ({ createTwapOrderTxs: () => [] }))
jest.mock('../services/extensibleFallbackSetupTxs', () => ({ extensibleFallbackSetupTxs: () => [] }))
jest.mock('../state/twapOrdersListAtom', () => ({ addTwapOrderToListAtom: {} }))
jest.mock('../utils/buildTwapOrderParamsStruct', () => ({ buildTwapOrderParamsStruct: () => ({}) }))
jest.mock('../utils/getConditionalOrderId', () => ({ getConditionalOrderId: () => 'order-id' }))
jest.mock('../utils/twapOrderToStruct', () => ({ twapOrderToStruct: () => ({}) }))

beforeEach(() => jest.clearAllMocks())

it('enrolls the Safe owner only after the order proposal is accepted', async () => {
  const pending: { resolve?: (hash: string) => void } = {}
  mockSend.mockReturnValue(
    new Promise<string>((resolve) => {
      pending.resolve = resolve
    }),
  )
  const { result } = renderHook(() => useCreateTwapOrder())
  const submission = result.current(false)
  await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
  expect(mockEnroll).not.toHaveBeenCalled()
  await act(async () => {
    pending.resolve?.('0xsafe-tx')
    await submission
  })
  expect(mockAddOrder).toHaveBeenCalledTimes(1)
  expect(mockEnroll).toHaveBeenCalledWith(account)
})

it('does not enroll when the order proposal is rejected', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  mockSend.mockRejectedValueOnce(new Error('User rejected'))
  try {
    const { result } = renderHook(() => useCreateTwapOrder())
    await act(async () => {
      await result.current(false)
    })
    expect(mockOnError).toHaveBeenCalledTimes(1)
    expect(mockAddOrder).not.toHaveBeenCalled()
    expect(mockEnroll).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})
