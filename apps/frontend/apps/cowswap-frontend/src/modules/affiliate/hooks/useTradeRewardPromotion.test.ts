import { isInjectedWidget } from '@cowprotocol/common-utils'

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useTradeRewardPromotion } from './useTradeRewardPromotion'

import { getTradeRewardCampaign } from '../lib/ophisAffiliateApi'

jest.mock('@cowprotocol/common-utils', () => ({ isInjectedWidget: jest.fn(() => false) }))
jest.mock('../lib/ophisAffiliateApi', () => ({ getTradeRewardCampaign: jest.fn() }))

it('hides the promotion for ineligible chains, unavailable campaigns, errors, and widgets', async () => {
  jest.useFakeTimers()
  const campaign = { campaignAvailable: true, eligibleChainIds: [4663] }
  const fetchCampaign = jest.mocked(getTradeRewardCampaign).mockImplementation(async () => ({ ...campaign }))
  try {
    const { result, rerender } = renderHook(({ chainId }) => useTradeRewardPromotion(chainId), {
      initialProps: { chainId: 4663 },
    })
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
    for (const chainId of [59144, 11155111, 999999]) {
      rerender({ chainId })
      expect(result.current).toBe(false)
    }
    rerender({ chainId: 4663 })
    campaign.campaignAvailable = false
    await act(() => jest.advanceTimersByTimeAsync(30_001))
    await waitFor(() => expect(result.current).toBe(false))
    campaign.campaignAvailable = true
    await act(() => jest.advanceTimersByTimeAsync(30_001))
    await waitFor(() => expect(result.current).toBe(true))
    fetchCampaign.mockRejectedValue(new Error('offline'))
    await act(() => jest.advanceTimersByTimeAsync(30_001))
    await waitFor(() => expect(result.current).toBe(false))
    jest.mocked(isInjectedWidget).mockReturnValue(true)
    rerender({ chainId: 4663 })
    expect(result.current).toBe(false)
    const requests = fetchCampaign.mock.calls.length
    await act(() => jest.advanceTimersByTimeAsync(30_001))
    expect(fetchCampaign).toHaveBeenCalledTimes(requests)
  } finally {
    cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.resetAllMocks()
  }
})
