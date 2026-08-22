import { act, renderHook } from '@testing-library/react'

import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
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
const HASH = `0x${'cd'.repeat(32)}` as const
const writeClient = {} as OtcReaderClient as OtcWriteClient
const wallet = {} as OtcWalletSubmitter

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
  beforeEach(() => submitMock.mockReset())

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
    expect(result.current.error).toBeNull()
    expect(result.current.pendingIntent).toBeNull()
    expect(refreshAllowance).not.toHaveBeenCalled()
  })
})
