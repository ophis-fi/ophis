import { getDefaultStore } from 'jotai'

import { BridgeStatus, CrossChainOrder } from '@cowprotocol/sdk-bridging'

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'

import { useCrossChainOrder } from './useCrossChainOrder'

jest.mock('tradingSdk/bridgingSdk', () => ({ bridgingSdk: { getOrder: jest.fn() } }))

const getOrder = jest.mocked(bridgingSdk.getOrder)
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
  const { result } = renderHook(() => useCrossChainOrder(1, 'order'))
  await waitFor(() => expect(result.current.data?.statusResult.status).toBe(BridgeStatus.IN_PROGRESS))
  await act(() => jest.advanceTimersByTimeAsync(5_001))
  await waitFor(() => expect(result.current.data?.statusResult.status).toBe(status))
  expect(getOrder).toHaveBeenCalledTimes(2)
  await act(() => jest.advanceTimersByTimeAsync(20_000))
  expect(getOrder).toHaveBeenCalledTimes(2)
})

it('waits for identifiers and resumes a request paused offline', async () => {
  getOrder.mockResolvedValue(order(BridgeStatus.IN_PROGRESS))
  const { result, rerender } = renderHook(({ uid }: { uid: string | undefined }) => useCrossChainOrder(1, uid), {
    initialProps: { uid: undefined as string | undefined },
  })
  expect(result.current.isLoading).toBe(false)
  expect(getOrder).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new Event('offline')))
  rerender({ uid: 'order' })
  await act(() => jest.advanceTimersByTimeAsync(10_000))
  expect(getOrder).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new Event('online')))
  await waitFor(() => expect(result.current.data?.statusResult.status).toBe(BridgeStatus.IN_PROGRESS))
  expect(getOrder).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, orderId: 'order' }))
})

it('pauses hidden-tab polling and keeps one cached request for concurrent consumers', async () => {
  getOrder.mockResolvedValue(order(BridgeStatus.IN_PROGRESS))
  renderHook(() => [useCrossChainOrder(1, 'order'), useCrossChainOrder(1, 'order')])
  await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1))
  const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => window.dispatchEvent(new Event('visibilitychange')))
  await act(() => jest.advanceTimersByTimeAsync(20_000))
  expect(getOrder).toHaveBeenCalledTimes(1)
  visibility.mockReturnValue('visible')
  act(() => window.dispatchEvent(new Event('visibilitychange')))
  expect(getOrder).toHaveBeenCalledTimes(1)
  await act(() => jest.advanceTimersByTimeAsync(5_001))
  expect(getOrder).toHaveBeenCalledTimes(2)
})
