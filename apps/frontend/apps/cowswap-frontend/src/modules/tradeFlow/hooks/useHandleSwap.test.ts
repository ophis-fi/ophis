import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { useGetAmountToSignApprove } from 'modules/erc20Approve'
import { ethFlow } from 'modules/ethFlow'
import { callWidgetHook } from 'modules/injectedWidget'
import { useAmountsToSignFromQuote } from 'modules/trade'

import { useNeedsApproval } from 'common/hooks/useNeedsApproval'

import { useHandleSwap } from './useHandleSwap'
import { useSafeBundleFlowContext } from './useSafeBundleFlowContext'
import { useTradeFlowContext } from './useTradeFlowContext'
import { useTradeFlowType } from './useTradeFlowType'

import { LinguiWrapper } from '../../../../LinguiJestProvider'
import { safeBundleApprovalFlow, safeBundleEthFlow } from '../services/safeBundleFlow'
import { swapFlow } from '../services/swapFlow'
import { FlowType, SafeBundleFlowContext, TradeFlowContext } from '../types/TradeFlowContext'

jest.mock('modules/erc20Approve', () => ({ useGetAmountToSignApprove: jest.fn() }))
jest.mock('modules/injectedWidget', () => ({ callWidgetHook: jest.fn(), buildTradeWidgetHookPayload: jest.fn() }))
jest.mock('modules/trade', () => ({ useAmountsToSignFromQuote: jest.fn(), useTradePriceImpact: () => ({}) }))
jest.mock('modules/ethFlow', () => ({ useEthFlowContext: () => null, ethFlow: jest.fn() }))
jest.mock('modules/trade/utils/tradeFlowAnalytics', () => ({ useTradeFlowAnalytics: () => ({}) }))
jest.mock('modules/trade/utils/logger', () => ({ logTradeFlow: jest.fn() }))
jest.mock('common/hooks/useNeedsApproval', () => ({ useNeedsApproval: jest.fn() }))
jest.mock('common/hooks/useConfirmPriceImpactWithoutFee', () => ({
  useConfirmPriceImpactWithoutFee: () => ({ confirmPriceImpactWithoutFee: jest.fn() }),
}))
jest.mock('./useTradeFlowType', () => ({ useTradeFlowType: jest.fn() }))
jest.mock('./useTradeFlowContext', () => ({ useTradeFlowContext: jest.fn() }))
jest.mock('./useSafeBundleFlowContext', () => ({ useSafeBundleFlowContext: jest.fn() }))
jest.mock('../services/safeBundleFlow', () => ({ safeBundleApprovalFlow: jest.fn(), safeBundleEthFlow: jest.fn() }))
jest.mock('../services/swapFlow', () => ({ swapFlow: jest.fn() }))

const token = new Token(1, '0x1234567890123456789012345678901234567890', 6, 'TEST')
const cap = CurrencyAmount.fromRawAmount(token, '10000000')
const required = CurrencyAmount.fromRawAmount(token, '11000000')
const onError = jest.fn()
const actions = {
  onUserInput: jest.fn(),
  onChangeRecipient: jest.fn(),
  onCurrencySelection: jest.fn(),
  onSwitchTokens: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useGetAmountToSignApprove).mockReturnValue(cap)
  jest
    .mocked(useAmountsToSignFromQuote)
    .mockReturnValue({ maximumSendSellAmount: required, minimumReceiveBuyAmount: cap })
  jest.mocked(useNeedsApproval).mockReturnValue(true)
  jest.mocked(callWidgetHook).mockResolvedValue(true)
  jest
    .mocked(useSafeBundleFlowContext)
    .mockReturnValue({ amountToApprove: cap, needsApproval: true } as SafeBundleFlowContext)
  jest.mocked(useTradeFlowContext).mockReturnValue({
    context: { inputAmount: required, outputAmount: cap },
    tradeConfirmActions: { onError },
    swapFlowAnalyticsContext: {},
    orderParams: { buyToken: token, sellToken: token },
    tradeQuoteState: { bridgeQuote: null },
  } as unknown as TradeFlowContext)
})

it.each([FlowType.REGULAR, FlowType.EOA_ETH_FLOW, FlowType.SAFE_BUNDLE_APPROVAL, FlowType.SAFE_BUNDLE_ETH])(
  'blocks a stale receiver-account quote before the %s signing path',
  async (flow) => {
    jest.mocked(useTradeFlowType).mockReturnValue(flow)
    jest.mocked(useTradeFlowContext).mockReturnValue({
      context: { inputAmount: required, outputAmount: cap },
      tradeConfirmActions: { onError },
      orderParams: {
        sellToken: token,
        buyToken: { chainId: AdditionalTargetChainId.SOLANA, address: 'So11111111111111111111111111111111111111112' },
        recipient: 'So11111111111111111111111111111111111111112',
        recipientAddressOrName: 'So11111111111111111111111111111111111111112',
      },
      tradeQuote: { quoteResults: { tradeParameters: { sellToken: token.address } } },
      tradeQuoteState: {
        bridgeQuote: {
          providerInfo: { type: 'ReceiverAccountBridgeProvider' },
          tradeParameters: {
            sellTokenChainId: 1,
            buyTokenChainId: AdditionalTargetChainId.SOLANA,
            buyTokenAddress: 'So11111111111111111111111111111111111111112',
            receiver: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          },
        },
      },
    } as unknown as TradeFlowContext)
    const { result } = renderHook(() => useHandleSwap({ deadline: 30 }, actions), { wrapper: LinguiWrapper })

    expect(result.current.contextIsReady).toBe(false)
    expect(await result.current.callback()).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
    expect(callWidgetHook).not.toHaveBeenCalled()
    expect(swapFlow).not.toHaveBeenCalled()
    expect(ethFlow).not.toHaveBeenCalled()
    expect(safeBundleApprovalFlow).not.toHaveBeenCalled()
    expect(safeBundleEthFlow).not.toHaveBeenCalled()
  },
)

it.each([FlowType.REGULAR, FlowType.SAFE_BUNDLE_APPROVAL, FlowType.SAFE_BUNDLE_ETH])(
  'blocks %s before any permit, batch or order can be signed above the cap',
  async (flow) => {
    jest.mocked(useTradeFlowType).mockReturnValue(flow)
    const { result } = renderHook(() => useHandleSwap({ deadline: 30 }, actions), { wrapper: LinguiWrapper })
    expect(await result.current.callback()).toBe(false)
    expect(onError).toHaveBeenCalledWith('Approved amount is not sufficient!')
    expect(callWidgetHook).not.toHaveBeenCalled()
    expect(swapFlow).not.toHaveBeenCalled()
    expect(safeBundleApprovalFlow).not.toHaveBeenCalled()
    expect(safeBundleEthFlow).not.toHaveBeenCalled()
  },
)

it('allows an order already covered by existing allowance without requesting a new approval', async () => {
  jest.mocked(useTradeFlowType).mockReturnValue(FlowType.REGULAR)
  jest.mocked(useNeedsApproval).mockReturnValue(false)
  jest.mocked(useGetAmountToSignApprove).mockReturnValue(CurrencyAmount.fromRawAmount(token, '0'))
  const { result } = renderHook(() => useHandleSwap({ deadline: 30 }, actions), { wrapper: LinguiWrapper })
  await result.current.callback()
  expect(onError).not.toHaveBeenCalled()
  expect(swapFlow).toHaveBeenCalledTimes(1)
})

it('allows an exact-cap bundle without widening its approval', async () => {
  jest.mocked(useTradeFlowType).mockReturnValue(FlowType.SAFE_BUNDLE_APPROVAL)
  jest.mocked(useAmountsToSignFromQuote).mockReturnValue({ maximumSendSellAmount: cap, minimumReceiveBuyAmount: cap })
  const { result } = renderHook(() => useHandleSwap({ deadline: 30 }, actions), { wrapper: LinguiWrapper })
  await result.current.callback()
  expect(onError).not.toHaveBeenCalled()
  expect(safeBundleApprovalFlow).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ amountToApprove: cap }),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  )
})
