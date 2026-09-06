import { getDefaultStore } from 'jotai'

import { act, renderHook } from '@testing-library/react'
import { uncertainOtcTransactionsAtom } from 'entities/otc'
import { installOtcWebLocksMock } from 'entities/otc/otcWebLocks.test.utils'

import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { submitOtcTransaction } from './prepareOtcTransaction'
import { useOtcSubmission, type OtcSubmissionOptions } from './useOtcSubmission'

import type { OtcTransactionReceipt, OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'
import type { OtcOrder, OtcReaderClient } from 'ophis/otc'

jest.mock('./prepareOtcTransaction', () => ({ submitOtcTransaction: jest.fn() }))

const submitMock = submitOtcTransaction as jest.MockedFunction<typeof submitOtcTransaction>
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const MAKER = '0x2222222222222222222222222222222222222222'
const TOKEN_A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // gitleaks:allow — public mainnet address
const TOKEN_B = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // gitleaks:allow — public mainnet address
const HASH = `0x${'cd'.repeat(32)}` as const
const writeClient = {} as OtcReaderClient as OtcWriteClient
const wallet = {} as OtcWalletSubmitter
const STORAGE_KEY = 'ophisOtcUncertainTransactions:v0'

const order: OtcOrder = {
  orderId: 7n,
  maker: MAKER,
  tokenA: TOKEN_A,
  amountA: 1n,
  tokenB: TOKEN_B,
  amountB: 2n,
  active: true,
}

function options(refreshAllowance: OtcSubmissionOptions['refreshAllowance']): OtcSubmissionOptions {
  return {
    writeClient,
    wallet,
    authorization: { isLocal: true, readFlag: true, writeFlag: true, writeMode: 'fork' },
    resetKey: 'order-7',
    account: ACCOUNT,
    requiredAllowance: 2n,
    refreshAllowance,
    onConfirmed: jest.fn(),
  }
}

describe('useOtcSubmission recovery boundaries', () => {
  beforeEach(() => {
    installOtcWebLocksMock()
    submitMock.mockReset()
    localStorage.removeItem(STORAGE_KEY)
    getDefaultStore().set(uncertainOtcTransactionsAtom, {})
  })

  it('clears fail-safe recovery after a fresh approval confirms', async () => {
    const refreshAllowance = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ allowance: 2n })
    submitMock.mockRejectedValueOnce(new Error('Ophis OTC order not active')).mockResolvedValueOnce({
      transactionHash: HASH,
      status: 'success',
      blockNumber: 10n,
    })
    const { result } = renderHook(() => useOtcSubmission(options(refreshAllowance)))

    await act(() => result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))
    expect(result.current.recoveryRequired).toBe(true)

    await act(() => result.current.submit({ kind: 'approve-fill', account: ACCOUNT, order }, false))
    expect(result.current.recoveryRequired).toBe(false)
    expect(result.current.successHash).toBe(HASH)
    expect(result.current.terminalConfirmed).toBe(false)
  })

  it('clears cooldown after a delayed allowance refresh stalls', async () => {
    jest.useFakeTimers()
    try {
      const refreshAllowance = jest
        .fn()
        .mockResolvedValueOnce({ allowance: 2n })
        .mockImplementationOnce(() => new Promise<never>(() => undefined))
      submitMock.mockResolvedValue({ transactionHash: HASH, status: 'success', blockNumber: 10n })
      const { result, unmount } = renderHook(() => useOtcSubmission(options(refreshAllowance)))

      await act(() => result.current.submit({ kind: 'approve-fill', account: ACCOUNT, order }, false))
      expect(result.current.allowanceCooldown).toBe(true)
      await act(async () => jest.advanceTimersByTimeAsync(9_000))
      expect(result.current.allowanceCooldown).toBe(false)
      unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  it('retains an uncertain broadcast hash and does not run failure recovery', async () => {
    const refreshAllowance = jest.fn().mockResolvedValue({ allowance: 0n })
    submitMock.mockRejectedValue(new OtcReceiptTrackingError(HASH, new Error('receipt RPC unavailable')))
    const { result } = renderHook(() => useOtcSubmission(options(refreshAllowance)))

    await act(() => result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))

    expect(result.current.uncertainHash).toBe(HASH)
    expect(result.current.successHash).toBeNull()
    expect(result.current.terminalConfirmed).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.pendingIntent).toBeNull()
    expect(refreshAllowance).not.toHaveBeenCalled()
  })

  it('restores an uncertain broadcast for the same account and reviewed intent after remount', async () => {
    submitMock.mockRejectedValue(new OtcReceiptTrackingError(HASH, new Error('receipt RPC unavailable')))
    const first = renderHook(() => useOtcSubmission(options(jest.fn().mockResolvedValue({ allowance: 0n }))))

    await act(() => first.result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))
    first.unmount()

    const second = renderHook(() => useOtcSubmission(options(jest.fn().mockResolvedValue({ allowance: 0n }))))
    expect(second.result.current.uncertainHash).toBe(HASH)
    expect(localStorage.getItem(STORAGE_KEY)).toContain(HASH)
  })

  it('persists the broadcast before confirmation and clears it only after a known receipt', async () => {
    let resolveReceipt: (receipt: OtcTransactionReceipt) => void = () => {
      throw new Error('Receipt wait was not started')
    }
    submitMock.mockImplementation((_client, _wallet, _intent, _authorization, _manifest, _context, onBroadcast) => {
      onBroadcast?.(HASH)
      return new Promise((resolve) => {
        resolveReceipt = resolve
      })
    })
    const refreshAllowance = jest.fn().mockResolvedValue({ allowance: 0n })
    const first = renderHook(() => useOtcSubmission(options(refreshAllowance)))
    let submission: Promise<void> = Promise.resolve()
    act(() => {
      submission = first.result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true)
    })
    expect(localStorage.getItem(STORAGE_KEY)).toContain(HASH)
    first.unmount()
    const second = renderHook(() => useOtcSubmission(options(refreshAllowance)))
    expect(second.result.current.uncertainHash).toBe(HASH)

    await act(async () => {
      resolveReceipt({ transactionHash: HASH, status: 'success', blockNumber: 10n })
      await submission
    })
    expect(second.result.current.uncertainHash).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(HASH)
  })

  it('allows a retry only after the user clears the exact uncertain action lock', async () => {
    submitMock.mockRejectedValueOnce(new OtcReceiptTrackingError(HASH, new Error('receipt RPC unavailable')))
    const { result } = renderHook(() => useOtcSubmission(options(jest.fn().mockResolvedValue({ allowance: 0n }))))

    await act(() => result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true))
    expect(result.current.uncertainHash).toBe(HASH)

    await act(() => result.current.clearUncertainTransaction(async () => undefined))

    expect(result.current.uncertainHash).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(HASH)
  })

  it('records a late uncertain result against the original intent after the action context changes', async () => {
    let rejectSubmission!: (error: Error) => void
    submitMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSubmission = reject
        }),
    )
    const refreshAllowance = jest.fn().mockResolvedValue({ allowance: 0n })
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: string }) => useOtcSubmission({ ...options(refreshAllowance), resetKey }),
      { initialProps: { resetKey: 'order-7' } },
    )

    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit({ kind: 'fill', account: ACCOUNT, order, deadline: 1n }, true)
    })
    rerender({ resetKey: 'order-8' })
    rejectSubmission(new OtcReceiptTrackingError(HASH, new Error('receipt RPC unavailable')))
    await act(async () => submission)

    expect(result.current.uncertainHash).toBeNull()
    rerender({ resetKey: 'order-7' })
    expect(result.current.uncertainHash).toBe(HASH)
  })
})
