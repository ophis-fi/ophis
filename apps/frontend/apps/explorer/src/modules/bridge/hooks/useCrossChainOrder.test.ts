import { getDefaultStore } from 'jotai'

import { BridgeStatus, CrossChainOrder, getCrossChainOrder } from '@cowprotocol/sdk-bridging'

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'

import { useCrossChainOrder } from './useCrossChainOrder'

jest.mock('@cowprotocol/sdk-bridging', () => ({
  ...jest.requireActual('@cowprotocol/sdk-bridging'),
  getCrossChainOrder: jest.fn(),
}))
jest.mock('sdk/cowSdk', () => ({ orderBookApi: {}, knownBridgeProviders: [] }))
jest.mock('../../../state/network', () => ({ useNetworkId: () => 1 }))

const getOrder = jest.mocked(getCrossChainOrder)
const order = (status: BridgeStatus, relayRecoveryRequired = false): CrossChainOrder =>
  ({ statusResult: { status, relayRecoveryRequired } }) as unknown as CrossChainOrder

beforeEach(() => {
  jest.useFakeTimers()
  getOrder.mockReset()
  getDefaultStore().get(queryClientAtom).clear()
})

afterEach(() => {
  act(() => window.dispatchEvent(new Event('online')))
  cleanup()
  getDefaultStore().get(queryClientAtom).clear()
  jest.restoreAllMocks()
  jest.clearAllTimers()
  jest.useRealTimers()
})

it.each([
  [BridgeStatus.EXECUTED, false],
  [BridgeStatus.EXPIRED, false],
  [BridgeStatus.REFUND, false],
  [BridgeStatus.UNKNOWN, true],
] as const)('stops polling on %s (recovery required: %s)', async (status, recovery) => {
  getOrder.mockResolvedValueOnce(order(BridgeStatus.IN_PROGRESS)).mockResolvedValue(order(status, recovery))
  const { result } = renderHook(() => useCrossChainOrder('order'))
  await waitFor(() => expect(result.current.data?.statusResult.status).toBe(BridgeStatus.IN_PROGRESS))
  await act(() => jest.advanceTimersByTimeAsync(15_001))
  await waitFor(() => expect(result.current.data?.statusResult.status).toBe(status))
  expect(getOrder).toHaveBeenCalledTimes(2)
  await act(() => jest.advanceTimersByTimeAsync(45_000))
  expect(getOrder).toHaveBeenCalledTimes(2)
})

it('waits for an order id and resumes offline requests with the staging fallback', async () => {
  getOrder
    .mockRejectedValueOnce(new Error('production order unavailable'))
    .mockResolvedValue(order(BridgeStatus.IN_PROGRESS))
  const { result, rerender } = renderHook(({ uid }: { uid: string | undefined }) => useCrossChainOrder(uid), {
    initialProps: { uid: undefined as string | undefined },
  })
  expect(result.current.isLoading).toBe(false)
  expect(getOrder).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new Event('offline')))
  rerender({ uid: 'order' })
  await act(() => jest.advanceTimersByTimeAsync(30_000))
  expect(getOrder).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new Event('online')))
  await waitFor(() => expect(result.current.data?.statusResult.status).toBe(BridgeStatus.IN_PROGRESS))
  expect(getOrder).toHaveBeenNthCalledWith(1, expect.objectContaining({ orderId: 'order', env: 'prod' }))
  expect(getOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({ orderId: 'order', env: 'staging' }))
})

it('pauses hidden-tab polling and keeps one cached request for concurrent consumers', async () => {
  getOrder.mockResolvedValue(order(BridgeStatus.IN_PROGRESS))
  renderHook(() => [useCrossChainOrder('order'), useCrossChainOrder('order')])
  await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1))
  const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => window.dispatchEvent(new Event('visibilitychange')))
  await act(() => jest.advanceTimersByTimeAsync(45_000))
  expect(getOrder).toHaveBeenCalledTimes(1)
  visibility.mockReturnValue('visible')
  act(() => window.dispatchEvent(new Event('visibilitychange')))
  expect(getOrder).toHaveBeenCalledTimes(1)
  await act(() => jest.advanceTimersByTimeAsync(15_001))
  expect(getOrder).toHaveBeenCalledTimes(2)
})
