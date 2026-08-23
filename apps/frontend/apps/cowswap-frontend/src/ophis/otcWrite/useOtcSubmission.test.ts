import { act, renderHook } from '@testing-library/react'

import { submitOtcTransaction } from './prepareOtcTransaction'
import { useOtcSubmission, type OtcSubmissionOptions } from './useOtcSubmission'

import type { OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'
import type { OtcOrder, OtcReaderClient } from 'ophis/otc'

jest.mock('./prepareOtcTransaction', () => ({ submitOtcTransaction: jest.fn() }))

const submitMock = submitOtcTransaction as jest.MockedFunction<typeof submitOtcTransaction>
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const MAKER = '0x2222222222222222222222222222222222222222'
const TOKEN_A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // gitleaks:allow — public mainnet address
const TOKEN_B = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // gitleaks:allow — public mainnet address
const HASH = `0x${'ab'.repeat(32)}` as const

const order: OtcOrder = {
  orderId: 7n,
  maker: MAKER,
  tokenA: TOKEN_A,
  amountA: 1n,
  tokenB: TOKEN_B,
  amountB: 2n,
  active: true,
}

const reader = {} as OtcReaderClient
const writeClient = reader as OtcWriteClient
const wallet = {} as OtcWalletSubmitter

function options(overrides: Partial<OtcSubmissionOptions> = {}): OtcSubmissionOptions {
  return {
    writeClient,
    wallet,
    authorization: { isLocal: true, readFlag: true, writeFlag: true, writeMode: 'fork' },
    resetKey: 'order-7',
    account: ACCOUNT,
    requiredAllowance: 2n,
    refreshAllowance: jest.fn().mockResolvedValue({ allowance: 0n }),
    onConfirmed: jest.fn(),
    ...overrides,
  }
}

describe('useOtcSubmission', () => {
  beforeEach(() => {
    submitMock.mockReset()
  })

  it('keeps approval confirmation successful when the immediate allowance re-read fails', async () => {
    submitMock.mockResolvedValue({ transactionHash: HASH, status: 'success', blockNumber: 10n })
    const refreshAllowance = jest.fn().mockRejectedValue(new Error('RPC unavailable'))
    const { result } = renderHook(() => useOtcSubmission(options({ refreshAllowance })))

    await act(() => result.current.submit({ kind: 'approve-fill', account: ACCOUNT, order }, false))

    expect(result.current.successHash).toBe(HASH)
    expect(result.current.error).toBeNull()
    expect(result.current.allowanceCooldown).toBe(true)
    expect(refreshAllowance).toHaveBeenCalledTimes(1)
  })

  it('publishes a confirmed hash when the post-receipt allowance refresh stalls', async () => {
    jest.useFakeTimers()
    try {
      submitMock.mockResolvedValue({ transactionHash: HASH, status: 'success', blockNumber: 10n })
      const refreshAllowance = jest.fn(() => new Promise<never>(() => undefined))
      const { result, unmount } = renderHook(() => useOtcSubmission(options({ refreshAllowance })))
      let submission!: Promise<void>

      act(() => {
        submission = result.current.submit({ kind: 'approve-fill', account: ACCOUNT, order }, false)
      })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000)
        await submission
      })

      expect(result.current.successHash).toBe(HASH)
      expect(result.current.pendingIntent).toBeNull()
      unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  it('offers revocation after a raced fill leaves a nonzero allowance', async () => {
    submitMock.mockRejectedValue(new Error('Ophis OTC order not active'))
    const refreshAllowance = jest.fn().mockResolvedValue({ allowance: 2n })
    const { result } = renderHook(() => useOtcSubmission(options({ refreshAllowance })))

    await act(() => result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))

    expect(result.current.error).toMatch(/filled, cancelled, or changed/)
    expect(result.current.recoveryRequired).toBe(true)
    expect(result.current.pendingIntent).toBeNull()
  })

  it('preserves recovery state when the post-failure allowance read is unavailable', async () => {
    submitMock.mockRejectedValue(new Error('Ophis OTC order not active'))
    const refreshAllowance = jest.fn().mockRejectedValue(new Error('RPC unavailable'))
    const { result } = renderHook(() => useOtcSubmission(options({ refreshAllowance })))

    await act(() => result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))

    expect(result.current.recoveryRequired).toBe(true)
    expect(refreshAllowance).toHaveBeenCalledTimes(1)
  })

  it('delegates the placeholder fill deadline to verified-block preflight', async () => {
    submitMock.mockResolvedValue({ transactionHash: HASH, status: 'success', blockNumber: 10n })
    const onConfirmed = jest.fn()
    const { result } = renderHook(() => useOtcSubmission(options({ onConfirmed })))

    await act(() => result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))

    expect(submitMock.mock.calls[0][2]).toMatchObject({ kind: 'fill', deadline: 1n })
    expect(onConfirmed).toHaveBeenCalledWith(HASH)
    expect(result.current.terminalConfirmed).toBe(true)
  })

  it('admits only one submission while the current wallet request is in flight', async () => {
    let resolveSubmission!: (value: Awaited<ReturnType<typeof submitOtcTransaction>>) => void
    submitMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve
        }),
    )
    const { result } = renderHook(() => useOtcSubmission(options({ requiredAllowance: null })))
    const intent = { kind: 'cancel' as const, account: MAKER, order }
    let submissions: Promise<void>[] = []

    act(() => {
      submissions = [result.current.submit(intent, false), result.current.submit(intent, false)]
    })
    expect(submitMock).toHaveBeenCalledTimes(1)

    resolveSubmission({ transactionHash: HASH, status: 'success', blockNumber: 10n })
    await act(async () => Promise.all(submissions))
    expect(result.current.pendingIntent).toBeNull()
  })

  it('discards a completed submission after the action context changes', async () => {
    let resolveSubmission!: (value: Awaited<ReturnType<typeof submitOtcTransaction>>) => void
    submitMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve
        }),
    )
    const oldConfirmed = jest.fn()
    const newConfirmed = jest.fn()
    const { result, rerender } = renderHook(
      ({ hookOptions }: { hookOptions: OtcSubmissionOptions }) => useOtcSubmission(hookOptions),
      { initialProps: { hookOptions: options({ onConfirmed: oldConfirmed }) } },
    )

    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit({ kind: 'cancel', account: MAKER, order }, true)
    })
    rerender({ hookOptions: options({ resetKey: 'order-8', onConfirmed: newConfirmed }) })
    resolveSubmission({ transactionHash: HASH, status: 'success', blockNumber: 10n })
    await act(async () => submission)

    expect(result.current.pendingIntent).toBeNull()
    expect(result.current.successHash).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.recoveryRequired).toBe(false)
    expect(result.current.allowanceCooldown).toBe(false)
    expect(oldConfirmed).not.toHaveBeenCalled()
    expect(newConfirmed).not.toHaveBeenCalled()
  })

  it('discards a failed submission and its recovery read after the action context changes', async () => {
    let rejectSubmission!: (error: Error) => void
    submitMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSubmission = reject
        }),
    )
    const refreshAllowance = jest.fn().mockResolvedValue({ allowance: 2n })
    const { result, rerender } = renderHook(
      ({ hookOptions }: { hookOptions: OtcSubmissionOptions }) => useOtcSubmission(hookOptions),
      { initialProps: { hookOptions: options({ refreshAllowance }) } },
    )

    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true)
    })
    rerender({ hookOptions: options({ resetKey: 'order-8', refreshAllowance }) })
    rejectSubmission(new Error('Ophis OTC order not active'))
    await act(async () => submission)

    expect(result.current.error).toBeNull()
    expect(result.current.recoveryRequired).toBe(false)
    expect(refreshAllowance).not.toHaveBeenCalled()
  })

  it('invalidates the wallet-bound context check on rerender and unmount', async () => {
    let isCurrentContext: (() => boolean) | undefined
    submitMock.mockImplementation(async (_client, _wallet, _intent, _authorization, _manifest, contextCheck) => {
      isCurrentContext = contextCheck
      throw new Error('Ophis OTC action context changed')
    })
    const { result, rerender, unmount } = renderHook(
      ({ hookOptions }: { hookOptions: OtcSubmissionOptions }) => useOtcSubmission(hookOptions),
      { initialProps: { hookOptions: options() } },
    )

    await act(() => result.current.submit({ kind: 'cancel', account: MAKER, order }, true))
    expect(isCurrentContext?.()).toBe(true)

    rerender({ hookOptions: options({ authorization: { ...options().authorization, writeFlag: false } }) })
    expect(isCurrentContext?.()).toBe(false)

    let mountedContext: (() => boolean) | undefined
    submitMock.mockImplementation(async (_client, _wallet, _intent, _authorization, _manifest, contextCheck) => {
      mountedContext = contextCheck
      return { transactionHash: HASH, status: 'success', blockNumber: 10n }
    })
    await act(() => result.current.submit({ kind: 'cancel', account: MAKER, order }, true))
    expect(mountedContext?.()).toBe(true)
    unmount()
    expect(mountedContext?.()).toBe(false)
  })
})
