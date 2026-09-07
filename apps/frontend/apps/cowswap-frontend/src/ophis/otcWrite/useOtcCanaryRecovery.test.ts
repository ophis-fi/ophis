import { getDefaultStore } from 'jotai'

import { getAddressKey } from '@cowprotocol/cow-sdk'

import { act, renderHook, waitFor } from '@testing-library/react'
import { recordUncertainOtcTransaction, uncertainOtcTransactionsAtom } from 'entities/otc'
import { installOtcWebLocksMock } from 'entities/otc/otcWebLocks.test.utils'

import { MAKER, TX_HASH } from './prepareOtcTransactionTest.utils'
import { useOtcSubmission } from './useOtcSubmission'

import type { OtcTransactionReceipt } from './otcWrite.types'
import type { OtcSubmissionOptions } from './useOtcSubmission'

const RESET_KEY = 'ethereum-mainnet\u0000create-reviewed'
const KEY = `${getAddressKey(MAKER)}\u0000${RESET_KEY}`
const OTHER_HASH = `0x${'cc'.repeat(32)}` as const
const receipt: OtcTransactionReceipt = { transactionHash: TX_HASH, status: 'success', blockNumber: 201n }
const store = getDefaultStore()

function options(): OtcSubmissionOptions & { wallet: NonNullable<OtcSubmissionOptions['wallet']> } {
  return {
    account: MAKER,
    resetKey: RESET_KEY,
    writeClient: null,
    wallet: { sendTransaction: jest.fn(), waitForTransactionReceipt: jest.fn().mockResolvedValue(receipt) },
    authorization: { isLocal: false, writeMode: 'canary', readFlag: true, writeFlag: true },
    requiredAllowance: null,
    refreshAllowance: jest.fn().mockResolvedValue({ allowance: 0n }),
    onConfirmed: jest.fn(),
  }
}

describe('canary receipt recovery', () => {
  beforeEach(() => {
    installOtcWebLocksMock()
    localStorage.removeItem('ophisOtcUncertainTransactions:v1')
    store.set(
      uncertainOtcTransactionsAtom,
      recordUncertainOtcTransaction({}, KEY, TX_HASH, undefined, { requestHash: TX_HASH, nonce: 3 }),
    )
  })

  it.each(['missing', 'unproven replacement', 'invalid status'])(
    'retains the lock for %s despite an origin acknowledgment',
    async (failure) => {
      const config = options()
      const wait = jest.mocked(config.wallet.waitForTransactionReceipt)
      if (failure === 'missing') wait.mockRejectedValue(new Error('receipt unavailable'))
      if (failure === 'unproven replacement') wait.mockResolvedValue({ ...receipt, transactionHash: OTHER_HASH })
      if (failure === 'invalid status') wait.mockResolvedValue({ ...receipt, status: 'unknown' as never })
      const { result } = renderHook(() => useOtcSubmission(config))
      await act(() => result.current.clearUncertainTransaction(async () => undefined))
      expect(result.current.uncertainHash).toBe(TX_HASH)
      expect(result.current.error).toBeTruthy()
      expect(config.onConfirmed).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'settles a known success, including an identical repricing (%s), without enabling repeat submission',
    async (repriced) => {
      const config = options()
      jest
        .mocked(config.wallet.waitForTransactionReceipt)
        .mockResolvedValue(
          repriced ? { ...receipt, transactionHash: OTHER_HASH, replacedTransactionHash: TX_HASH } : receipt,
        )
      const { result } = renderHook(() => useOtcSubmission(config))
      const verify = jest.fn(async () => undefined)
      await act(() => result.current.clearUncertainTransaction(verify))
      expect(verify).toHaveBeenCalledTimes(2)
      expect(result.current.uncertainHash).toBeNull()
      expect(result.current.terminalConfirmed).toBe(true)
      expect(result.current.successHash).toBe(repriced ? OTHER_HASH : TX_HASH)
      expect(config.onConfirmed).toHaveBeenCalledTimes(1)
      expect(store.get(uncertainOtcTransactionsAtom)[KEY]).toBeUndefined()
    },
  )

  it('reconciles an operator-supplied hash for a durable hashless attempt using its original proof', async () => {
    const proof = { requestHash: TX_HASH, nonce: 3 }
    store.set(uncertainOtcTransactionsAtom, recordUncertainOtcTransaction({}, KEY, null, undefined, proof))
    const config = options()
    const { result } = renderHook(() => useOtcSubmission(config))
    expect(result.current.signatureUncertain).toBe(true)
    await act(() => result.current.clearUncertainTransaction(async () => undefined, TX_HASH))
    expect(config.wallet.waitForTransactionReceipt).toHaveBeenCalledWith(TX_HASH, proof)
    expect(result.current.signatureUncertain).toBe(false)
    expect(result.current.terminalConfirmed).toBe(true)
  })

  it('retains a hashless attempt if the supplied hash has no matching canonical transaction', async () => {
    store.set(
      uncertainOtcTransactionsAtom,
      recordUncertainOtcTransaction({}, KEY, null, undefined, { requestHash: TX_HASH, nonce: 3 }),
    )
    const config = options()
    jest
      .mocked(config.wallet.waitForTransactionReceipt)
      .mockRejectedValue(new Error('confirmed transaction differs from reviewed intent'))
    const { result } = renderHook(() => useOtcSubmission(config))
    await act(() => result.current.clearUncertainTransaction(async () => undefined, OTHER_HASH))
    expect(result.current.signatureUncertain).toBe(true)
    expect(result.current.terminalConfirmed).toBe(false)
    expect(config.onConfirmed).not.toHaveBeenCalled()
  })

  it('rejects stale recovery when another tab replaced a hashless attempt before storage events arrive', async () => {
    const proof = { requestHash: TX_HASH, nonce: 3 }
    const first = recordUncertainOtcTransaction({}, KEY, null, 1, proof)
    store.set(uncertainOtcTransactionsAtom, first)
    const config = options()
    const { result } = renderHook(() => useOtcSubmission(config))
    // Same hash, timestamp and proof: only the unique attempt identity differs.
    const second = recordUncertainOtcTransaction({}, KEY, null, 1, proof)
    expect(second[KEY].attemptId).not.toBe(first[KEY].attemptId)
    localStorage.setItem('ophisOtcUncertainTransactions:v1', JSON.stringify(second))
    await act(() => result.current.clearUncertainTransaction(async () => undefined, TX_HASH))
    expect(config.wallet.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(config.onConfirmed).not.toHaveBeenCalled()
    expect(store.get(uncertainOtcTransactionsAtom)[KEY]).toEqual(second[KEY])
    expect(result.current.signatureUncertain).toBe(true)
  })

  it('permits allowance recovery after a known revert', async () => {
    const config = options()
    jest.mocked(config.wallet.waitForTransactionReceipt).mockResolvedValue({ ...receipt, status: 'reverted' })
    const { result } = renderHook(() => useOtcSubmission(config))
    await act(() => result.current.clearUncertainTransaction(async () => undefined))
    expect(result.current.uncertainHash).toBeNull()
    expect(result.current.terminalConfirmed).toBe(false)
    expect(result.current.recoveryRequired).toBe(true)
    expect(result.current.error).toMatch(/reverted/)
    expect(config.onConfirmed).not.toHaveBeenCalled()
  })

  it('retains the original lock when the wallet changes during receipt tracking', async () => {
    const config = options()
    let confirm: ((receipt: OtcTransactionReceipt) => void) | undefined
    jest.mocked(config.wallet.waitForTransactionReceipt).mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        }),
    )
    const { result, rerender } = renderHook((props) => useOtcSubmission(props), { initialProps: config })
    let recovery: Promise<void> | undefined
    act(() => {
      recovery = result.current.clearUncertainTransaction(async () => undefined)
    })
    await waitFor(() => expect(confirm).toBeDefined())
    expect(result.current.pendingIntent).toBe('reconcile')
    rerender({ ...config, wallet: options().wallet })
    await act(async () => {
      if (!confirm) throw new Error('Receipt tracking did not start')
      confirm(receipt)
      await recovery
    })
    expect(result.current.uncertainHash).toBe(TX_HASH)
    expect(result.current.terminalConfirmed).toBe(false)
    expect(config.onConfirmed).not.toHaveBeenCalled()
  })

  it('retains the lock if network verification fails after the receipt arrives', async () => {
    const config = options()
    const verify = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('wallet network changed'))
    const { result } = renderHook(() => useOtcSubmission(config))
    await act(() => result.current.clearUncertainTransaction(verify))
    expect(result.current.uncertainHash).toBe(TX_HASH)
    expect(config.onConfirmed).not.toHaveBeenCalled()
  })

  it('reconciles a mainnet lock across transports without changing callback or result identity on routine renders', async () => {
    const config = options()
    const { result, rerender } = renderHook((props) => useOtcSubmission(props), { initialProps: config })
    const original = result.current
    rerender({ ...config })
    expect(result.current).toBe(original)
    rerender({ ...config, wallet: options().wallet })
    expect(result.current.uncertainHash).toBe(TX_HASH)
    expect(result.current.clearUncertainTransaction).toBe(original.clearUncertainTransaction)
    await act(() => result.current.clearUncertainTransaction(async () => undefined))
    expect(result.current.terminalConfirmed).toBe(true)
  })
})
