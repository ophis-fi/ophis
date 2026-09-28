import { OrderKind, PriceQuality } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'
import { useSWRConfig } from 'swr'

import { useTradeFlowContext } from './useTradeFlowContext'

jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: mockState.account }),
  useWalletDetails: () => ({ allowsOffchainSigning: true }),
  useIsSafeWallet: () => false,
}))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => mockState.provider }))
jest.mock('entities/bridgeOrders', () => ({ useAddBridgeOrder: () => mockCallback }))
jest.mock('react-redux', () => ({ useDispatch: () => mockCallback }))
jest.mock('legacy/state/application/hooks', () => ({ useCloseModals: () => mockCallback }))
jest.mock('modules/appData', () => ({ useAppData: () => mockEmpty, useAppDataHooks: () => undefined }))
jest.mock('modules/bridge', () => ({ useBridgeQuoteAmounts: () => null }))
jest.mock('modules/erc20Approve', () => ({ useGetAmountToSignApprove: () => mockInputAmount }))
jest.mock('modules/permit', () => ({
  useGeneratePermitHook: () => mockCallback,
  useGetCachedPermit: () => mockState.getCachedPermit,
  usePermitInfo: () => undefined,
}))
jest.mock('modules/trade', () => ({
  TradeTypeToUiOrderType: { swap: 'swap' },
  useDerivedTradeState: () => mockDerived,
  useGetReceiveAmountInfo: () => mockReceiveAmounts,
  useIsHooksTradeType: () => false,
  useTradeConfirmActions: () => mockEmpty,
  useTradeTypeInfo: () => ({ tradeType: 'swap' }),
}))
jest.mock('modules/tradeQuote', () => ({
  getOrderValidTo: (deadline: number) => deadline,
  useTradeQuote: () => (mockState.missingQuote ? { ...mockState.tradeQuote, quote: null } : mockState.tradeQuote),
}))
jest.mock('common/hooks/useContract', () => ({
  useGP2SettlementContract: () => ({ contract: mockState.contract, chainId: mockState.chainId }),
}))
jest.mock('common/hooks/useEnoughAllowance', () => ({ useEnoughAllowance: () => false }))
jest.mock('common/hooks/useVerifyOphisRecipientName', () => ({ useVerifyOphisRecipientName: () => mockCallback }))
jest.mock('./useSetSigningStep', () => ({ useSetSigningStep: () => mockCallback }))

const mockCallback = jest.fn()
const mockEmpty = {}
const mockSdkGraphReads = jest.fn()

function createProvider(signer: object = {}): { getUncheckedSigner: () => object; readonly walletConnectSdk: never } {
  return {
    getUncheckedSigner: jest.fn(() => signer),
    // An enumerable SDK graph must not be traversed to construct a cache key.
    get walletConnectSdk(): never {
      mockSdkGraphReads()
      throw new Error('WalletConnect SDK graph was serialized')
    },
  }
}

const mockInputAmount = { currency: { symbol: 'USDC', chainId: 5042 }, quotient: 10000000n }
const mockOutputAmount = { currency: { symbol: 'cirBTC', chainId: 5042 } }
const mockDerived = {
  inputCurrency: mockInputAmount.currency,
  outputCurrency: mockOutputAmount.currency,
  orderKind: OrderKind.SELL,
}
const mockReceiveAmounts = {
  amountsToSign: { sellAmount: mockInputAmount, buyAmount: mockOutputAmount },
  afterNetworkCosts: { sellAmount: mockInputAmount },
  costs: { networkFee: { amountInSellCurrency: mockInputAmount } },
}
const mockState = {
  account: '0x3333333333333333333333333333333333333333',
  chainId: 5042,
  provider: createProvider(),
  contract: {},
  tradeQuote: {
    quote: { quoteResults: { quoteResponse: { id: 1 } } },
    fetchParams: { priceQuality: PriceQuality.OPTIMAL },
  },
  missingQuote: false,
  getCachedPermit: jest.fn(),
}

it('derives current contexts without serializing or caching the live wallet graph', () => {
  const { result, rerender } = renderHook(
    ({ deadline }) => ({ context: useTradeFlowContext({ deadline }), cache: useSWRConfig().cache }),
    { initialProps: { deadline: 1000 } },
  )
  const initialCacheKeys = Array.from(result.current.cache.keys())
  Array.from({ length: 100 }, (_, index) => 1001 + index).forEach((deadline) => {
    rerender({ deadline })
    expect(result.current.context?.orderParams.validTo).toBe(deadline)
  })
  expect(mockSdkGraphReads).not.toHaveBeenCalled()
  expect(Array.from(result.current.cache.keys())).toEqual(initialCacheKeys)
  const context = result.current.context
  rerender({ deadline: 1100 })
  expect(result.current.context).toBe(context)
  expect(mockState.provider.getUncheckedSigner).toHaveBeenCalledTimes(101)

  const replacementSigner = {}
  mockState.account = '0x4444444444444444444444444444444444444444'
  mockState.chainId = 1
  mockState.provider = createProvider(replacementSigner)
  mockState.contract = {}
  mockState.tradeQuote = {
    quote: { quoteResults: { quoteResponse: { id: 2 } } },
    fetchParams: { priceQuality: PriceQuality.OPTIMAL },
  }
  rerender({ deadline: 1100 })
  expect(result.current.context?.orderParams).toMatchObject({ account: mockState.account, chainId: 1, quoteId: 2 })
  expect(result.current.context?.orderParams.signer).toBe(replacementSigner)
  expect(result.current.context?.contract).toBe(mockState.contract)
  expect(result.current.context?.tradeQuote).toBe(mockState.tradeQuote.quote)

  mockState.getCachedPermit = jest.fn()
  rerender({ deadline: 1100 })
  expect(result.current.context?.callbacks.getCachedPermit).toBe(mockState.getCachedPermit)
  mockState.missingQuote = true
  rerender({ deadline: 1100 })
  expect(result.current.context).toBeNull()
  mockState.missingQuote = false
  rerender({ deadline: 1100 })
  expect(result.current.context).not.toBeNull()
  rerender({ deadline: 0 })
  expect(result.current.context).toBeNull()
})
