import { useIsOnline, useIsWindowVisible } from '@cowprotocol/common-hooks'

import { act, renderHook } from '@testing-library/react'

import { type BtcSwapPending } from './btcSwapState'
import { getBtcSwapStatus } from './btcSwapStatus.service'
type BtcStatus = Awaited<ReturnType<typeof getBtcSwapStatus>>
import { useBtcSwapStatus } from './useBtcSwapStatus'

jest.mock('@cowprotocol/common-hooks', () => ({ useIsOnline: jest.fn(), useIsWindowVisible: jest.fn() }))
jest.mock('./btcSwapStatus.service', () => ({ getBtcSwapStatus: jest.fn() }))
const transfer: BtcSwapPending = {
  type: 'wbtcToArc',
  owner: '0x0000000000000000000000000000000000000001',
  orderUid: `0x${'ab'.repeat(56)}`,
  sellAmount: '1000000',
  minimumBuyAmount: '990000',
  validTo: 1000,
}
const pending: BtcStatus = { text: 'pending' }

it('pauses polling offline/hidden, stops at completion and ignores stale in-flight results', async () => {
  jest.useFakeTimers()
  jest.mocked(useIsOnline).mockReturnValue(true)
  jest.mocked(useIsWindowVisible).mockReturnValue(true)
  jest.mocked(getBtcSwapStatus).mockResolvedValue(pending)
  const { result, rerender, unmount } = renderHook(({ transfer }) => useBtcSwapStatus(transfer), {
    initialProps: { transfer },
  })
  await act(async () => undefined)
  expect(getBtcSwapStatus).toHaveBeenCalledTimes(1)
  jest.mocked(useIsWindowVisible).mockReturnValue(false)
  rerender({ transfer })
  await act(async () => jest.advanceTimersByTime(60000))
  expect(getBtcSwapStatus).toHaveBeenCalledTimes(1)
  jest.mocked(useIsWindowVisible).mockReturnValue(true)
  jest.mocked(useIsOnline).mockReturnValue(false)
  rerender({ transfer })
  await act(async () => jest.advanceTimersByTime(60000))
  expect(getBtcSwapStatus).toHaveBeenCalledTimes(1)
  let resolve: (status: BtcStatus) => void = () => undefined
  jest.mocked(getBtcSwapStatus).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  jest.mocked(useIsOnline).mockReturnValue(true)
  rerender({ transfer })
  const next = { ...transfer, settlementHash: `0x${'cd'.repeat(32)}` as const }
  rerender({ transfer: next })
  await act(async () => resolve({ ...pending, amount: '995000' }))
  expect(result.current.status?.amount).toBeUndefined()
  jest.mocked(getBtcSwapStatus).mockResolvedValue({ ...pending, amount: '995000' })
  await act(async () => jest.advanceTimersByTime(15000))
  expect(result.current.status?.amount).toBe('995000')
  const calls = jest.mocked(getBtcSwapStatus).mock.calls.length
  await act(async () => jest.advanceTimersByTime(60000))
  expect(getBtcSwapStatus).toHaveBeenCalledTimes(calls)
  unmount()
  jest.useRealTimers()
})
