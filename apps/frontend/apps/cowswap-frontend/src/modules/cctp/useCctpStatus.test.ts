import { useIsOnline, useIsWindowVisible } from '@cowprotocol/common-hooks'

import { act, renderHook } from '@testing-library/react'

import { type CctpTransfer } from './cctp.service'
import { getCctpStatus, type CctpStatus } from './cctpStatus.service'
import { useCctpStatus } from './useCctpStatus'

jest.mock('@cowprotocol/common-hooks', () => ({ useIsOnline: jest.fn(), useIsWindowVisible: jest.fn() }))
jest.mock('./cctpStatus.service', () => ({ getCctpStatus: jest.fn() }))
const transfer: CctpTransfer = {
  source: 8453,
  destination: 5042,
  owner: '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A',
  amount: '2000000',
  maxFee: '15638',
  quotedAt: 1000,
  burnHash: `0x${'ab'.repeat(32)}`,
}
const pending: CctpStatus = { text: 'pending', sourceConfirmed: true, completed: false, failed: false }

it('pauses polling offline/hidden, stops at completion and ignores stale in-flight results', async () => {
  jest.useFakeTimers()
  jest.mocked(useIsOnline).mockReturnValue(true)
  jest.mocked(useIsWindowVisible).mockReturnValue(true)
  jest.mocked(getCctpStatus).mockResolvedValue(pending)
  const { result, rerender, unmount } = renderHook(({ transfer }) => useCctpStatus(transfer), {
    initialProps: { transfer },
  })
  await act(async () => undefined)
  expect(getCctpStatus).toHaveBeenCalledTimes(1)
  jest.mocked(useIsWindowVisible).mockReturnValue(false)
  rerender({ transfer })
  await act(async () => jest.advanceTimersByTime(60000))
  expect(getCctpStatus).toHaveBeenCalledTimes(1)
  jest.mocked(useIsWindowVisible).mockReturnValue(true)
  jest.mocked(useIsOnline).mockReturnValue(false)
  rerender({ transfer })
  await act(async () => jest.advanceTimersByTime(60000))
  expect(getCctpStatus).toHaveBeenCalledTimes(1)
  let resolve: (status: CctpStatus) => void = () => undefined
  jest.mocked(getCctpStatus).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  jest.mocked(useIsOnline).mockReturnValue(true)
  rerender({ transfer })
  const next = { ...transfer, burnHash: `0x${'cd'.repeat(32)}` as const }
  rerender({ transfer: next })
  await act(async () => resolve({ ...pending, completed: true }))
  expect(result.current.status?.completed).toBe(false)
  jest.mocked(getCctpStatus).mockResolvedValue({ ...pending, completed: true })
  await act(async () => jest.advanceTimersByTime(15000))
  expect(result.current.status?.completed).toBe(true)
  const calls = jest.mocked(getCctpStatus).mock.calls.length
  await act(async () => jest.advanceTimersByTime(60000))
  expect(getCctpStatus).toHaveBeenCalledTimes(calls)
  unmount()
  jest.useRealTimers()
})
