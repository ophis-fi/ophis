import { getDefaultStore } from 'jotai'

import * as Sentry from '@sentry/react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { orderBookApi } from 'cowSdk'
import { queryClientAtom } from 'jotai-tanstack-query'

import { useSettlementTxHash } from './useSettlementTxHash'

jest.mock('cowSdk', () => ({ orderBookApi: { getTrades: jest.fn() } }))
jest.mock('@sentry/react', () => ({ addBreadcrumb: jest.fn() }))

const getTrades = jest.mocked(orderBookApi.getTrades)
const uid = `0x${'ab'.repeat(56)}`
const txHash = `0x${'cd'.repeat(32)}`
const settledTrades = [{ txHash: `0x${'ef'.repeat(32)}` }, { txHash }, { txHash: null }] as Awaited<
  ReturnType<typeof getTrades>
>

beforeEach(() => {
  jest.useFakeTimers()
  getTrades.mockReset()
  getDefaultStore().get(queryClientAtom).clear()
})

afterEach(() => {
  cleanup()
  getDefaultStore().get(queryClientAtom).clear()
  jest.restoreAllMocks()
  jest.clearAllTimers()
  jest.useRealTimers()
})

it('polls pending and failed lookups, then stops at the latest settlement hash', async () => {
  const error = new Error('orderbook unavailable')
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  getTrades.mockResolvedValueOnce([]).mockRejectedValueOnce(error).mockResolvedValue(settledTrades)
  const { result } = renderHook(() => useSettlementTxHash(10, uid))
  await waitFor(() => expect(getTrades).toHaveBeenCalledTimes(1))
  expect(result.current).toBeNull()
  await act(() => jest.advanceTimersByTimeAsync(8001))
  expect(result.current).toBeNull()
  expect(warn).toHaveBeenCalledWith(expect.any(String), { chainId: 10, orderUid: uid, error })
  expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }))
  await act(() => jest.advanceTimersByTimeAsync(8001))
  await waitFor(() => expect(result.current).toBe(txHash))
  expect(getTrades).toHaveBeenCalledTimes(3)
  await act(() => jest.advanceTimersByTimeAsync(24_000))
  expect(getTrades).toHaveBeenCalledTimes(3)
})

it('deduplicates concurrent consumers and keys cached lookups by chain and order', async () => {
  getTrades.mockResolvedValue(settledTrades)
  const { result, rerender } = renderHook(
    ({ chainId, orderUid }) => [useSettlementTxHash(chainId, orderUid), useSettlementTxHash(chainId, orderUid)],
    { initialProps: { chainId: 10, orderUid: uid } },
  )
  await waitFor(() => expect(result.current).toEqual([txHash, txHash]))
  expect(getTrades).toHaveBeenCalledTimes(1)
  expect(getDefaultStore().get(queryClientAtom).getQueryData(['ophis-settlement-tx', 10, uid])).toBe(txHash)
  rerender({ chainId: 4663, orderUid: uid })
  await waitFor(() => expect(getTrades).toHaveBeenCalledTimes(2))
  const otherUid = `0x${'ef'.repeat(56)}`
  rerender({ chainId: 4663, orderUid: otherUid })
  await waitFor(() => expect(getTrades).toHaveBeenCalledTimes(3))
  expect(getTrades).toHaveBeenLastCalledWith({ orderUid: otherUid }, { chainId: 4663 })
})

it.each([
  [130, uid],
  [undefined, uid],
  [10, undefined],
  [10, 'invalid'],
])('does not fetch for a retired chain or missing identifiers (%s, %s)', async (chainId, orderUid) => {
  const { result } = renderHook(() => useSettlementTxHash(chainId, orderUid))
  await act(() => jest.advanceTimersByTimeAsync(16_000))
  expect(result.current).toBeNull()
  expect(getTrades).not.toHaveBeenCalled()
})
