import { USDC_BASE, USDT_BASE } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'

import { tradingSdk } from 'tradingSdk/tradingSdk'

import { buildApproveTx } from 'modules/operations/bundle/buildApproveTx'
import { handlePermit } from 'modules/permit'
import { TradeFlowAnalytics } from 'modules/trade/utils/tradeFlowAnalytics'

import { safeBundleFlow } from './safeBundleFlow'
import { tradeFlow } from './tradeFlow'
import { SafeBundleFlowContext } from './types'

import { defaultLimitOrdersSettings } from '../state/limitOrdersSettingsAtom'

jest.mock('tradingSdk/tradingSdk', () => ({ tradingSdk: { postLimitOrder: jest.fn() } }))
jest.mock('@cowprotocol/tokens', () => ({
  assertTradeTokenPolicy: jest.fn(),
  TokenPolicyProfile: { ESTABLISHED_SETTLEMENT: 'established' },
}))
jest.mock('modules/permit', () => ({ handlePermit: jest.fn() }))
jest.mock('modules/orders', () => ({ emitPostedOrderEvent: jest.fn() }))
jest.mock('modules/zeroApproval', () => ({ shouldZeroApprove: jest.fn() }))
jest.mock('modules/appData', () => ({ removePermitHookFromAppData: jest.fn().mockResolvedValue({}) }))
jest.mock('modules/operations/bundle/buildApproveTx', () => ({ buildApproveTx: jest.fn() }))
jest.mock('../utils/calculateLimitOrdersDeadline', () => ({ calculateLimitOrdersDeadline: () => 2000000000 }))

it.each([false, true])('keeps a 10-token limit at the signing boundary (bundle=%s)', async (isBundle) => {
  const amount = CurrencyAmount.fromRawAmount(USDC_BASE, '10000000')
  const params = {
    amountToApprove: amount,
    needsApproval: true,
    rateImpact: 0,
    permitInfo: { type: 'eip-2612' },
    postOrderParams: {
      inputAmount: amount,
      outputAmount: CurrencyAmount.fromRawAmount(USDT_BASE, '10000000'),
      sellToken: USDC_BASE,
      buyToken: USDT_BASE,
      appData: {},
    },
  } as unknown as SafeBundleFlowContext
  const analytics = {
    trade: jest.fn(),
    approveAndPresign: jest.fn(),
    error: jest.fn(),
  } as unknown as TradeFlowAnalytics
  const stop = new Error('Stop before wallet or order submission')
  jest.mocked(handlePermit).mockRejectedValue(stop)
  jest.mocked(buildApproveTx).mockRejectedValue(stop)

  const result = isBundle
    ? safeBundleFlow(params, { loading: false }, defaultLimitOrdersSettings, async () => true, analytics)
    : tradeFlow(
        params,
        { loading: false },
        defaultLimitOrdersSettings,
        analytics,
        async () => true,
        async () => undefined,
        () => undefined,
      )

  await expect(result).rejects.toThrow(stop.message)
  if (isBundle) {
    expect(buildApproveTx).toHaveBeenCalledWith(expect.objectContaining({ amountToApprove: 10000000n }))
  } else {
    expect(handlePermit).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000000n }))
  }
  expect(tradingSdk.postLimitOrder).not.toHaveBeenCalled()
})
