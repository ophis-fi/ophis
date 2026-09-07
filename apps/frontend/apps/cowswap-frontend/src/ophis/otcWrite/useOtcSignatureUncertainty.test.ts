import { getDefaultStore } from 'jotai'

import { getAddressKey } from '@cowprotocol/cow-sdk'

import { act, renderHook } from '@testing-library/react'
import { uncertainOtcTransactionsAtom } from 'entities/otc'
import { installOtcWebLocksMock } from 'entities/otc/otcWebLocks.test.utils'

import { submitOtcTransaction } from './prepareOtcTransaction'
import { MAKER, mockOtcOrder, TX_HASH } from './prepareOtcTransactionTest.utils'
import { useOtcSubmission } from './useOtcSubmission'

import type { OtcSubmissionOptions } from './useOtcSubmission'

jest.mock('./prepareOtcTransaction', () => ({ submitOtcTransaction: jest.fn() }))
const submit = jest.mocked(submitOtcTransaction)
const INTENT = { kind: 'create' as const, account: MAKER, draft: mockOtcOrder() }
const KEY = `${getAddressKey(MAKER)}\u0000ethereum-mainnet\u0000reviewed-create`
const STORAGE_KEY = 'ophisOtcUncertainTransactions:v1'

function options(): OtcSubmissionOptions {
  return {
    account: MAKER,
    resetKey: 'ethereum-mainnet\u0000reviewed-create',
    writeClient: {} as never,
    wallet: { sendTransaction: jest.fn(), waitForTransactionReceipt: jest.fn() },
    authorization: { isLocal: false, readFlag: true, writeFlag: true, writeMode: 'canary' },
    requiredAllowance: null,
    refreshAllowance: jest.fn().mockResolvedValue({ allowance: 0n }),
    onConfirmed: jest.fn(),
  }
}

beforeEach(() => {
  installOtcWebLocksMock()
  submit.mockReset()
  localStorage.removeItem(STORAGE_KEY)
  getDefaultStore().set(uncertainOtcTransactionsAtom, {})
})

it('retains a durable no-hash lock for a send response lost after possible broadcast', async () => {
  submit.mockImplementation(async (_c, _w, _i, _a, _m, _ctx, _broadcast, onPrompt) => {
    onPrompt?.({ requestHash: TX_HASH, nonce: 3 })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')?.[KEY]?.transactionHash).toBeNull()
    throw new Error('RPC disconnected after broadcast')
  })
  const config = options()
  const first = renderHook(() => useOtcSubmission(config))
  await act(() => first.result.current.submit(INTENT, true))
  expect(first.result.current.signatureUncertain).toBe(true)
  first.unmount()
  const second = renderHook(() => useOtcSubmission(config))
  expect(second.result.current.signatureUncertain).toBe(true)
  await act(() => second.result.current.clearUncertainTransaction(async () => undefined))
  await act(() => second.result.current.submit(INTENT, true))
  expect(submit).toHaveBeenCalledTimes(1)
  expect(second.result.current.signatureUncertain).toBe(true)
})

it('persists uncertainty before a wallet prompt, including remount before its response', async () => {
  let resolve: ((receipt: Awaited<ReturnType<typeof submitOtcTransaction>>) => void) | undefined
  let broadcast: ((hash: typeof TX_HASH) => void) | undefined
  submit.mockImplementation((_c, _w, _i, _a, _m, _ctx, onBroadcast, onPrompt) => {
    onPrompt?.({ requestHash: TX_HASH, nonce: 3 })
    broadcast = (hash) => onBroadcast?.(hash)
    return new Promise((finish) => {
      resolve = finish
    })
  })
  const config = options()
  const first = renderHook(() => useOtcSubmission(config))
  let pending: Promise<void> | undefined
  act(() => {
    pending = first.result.current.submit(INTENT, true)
  })
  first.unmount()
  const second = renderHook(() => useOtcSubmission(config))
  expect(second.result.current.signatureUncertain).toBe(true)
  await act(() => second.result.current.submit(INTENT, true))
  expect(submit).toHaveBeenCalledTimes(1)
  act(() => broadcast?.(TX_HASH))
  expect(second.result.current.signatureUncertain).toBe(false)
  expect(second.result.current.uncertainHash).toBe(TX_HASH)
  await act(async () => {
    if (!resolve) throw new Error('Submission did not start')
    resolve({ transactionHash: TX_HASH, status: 'success', blockNumber: 201n })
    await pending
  })
  expect(second.result.current.uncertainHash).toBeNull()
})

it.each([{ code: 4001 }, { cause: { code: 4001 } }])(
  'retains a lock even for an unproven 4001 rejection after the prompt: %s',
  async (rejection) => {
    submit.mockImplementation(async (_c, _w, _i, _a, _m, _ctx, _broadcast, onPrompt) => {
      onPrompt?.({ requestHash: TX_HASH, nonce: 3 })
      throw rejection
    })
    const config = options()
    const { result } = renderHook(() => useOtcSubmission(config))
    await act(() => result.current.submit(INTENT, true))
    expect(result.current.signatureUncertain).toBe(true)
    expect(getDefaultStore().get(uncertainOtcTransactionsAtom)[KEY].transactionHash).toBeNull()
  },
)

it('does not infer a definitive rejection from arbitrary error text', async () => {
  submit.mockImplementation(async (_c, _w, _i, _a, _m, _ctx, _broadcast, onPrompt) => {
    onPrompt?.({ requestHash: TX_HASH, nonce: 3 })
    throw new Error('user rejected')
  })
  const config = options()
  const { result } = renderHook(() => useOtcSubmission(config))
  await act(() => result.current.submit(INTENT, true))
  expect(result.current.signatureUncertain).toBe(true)
})
