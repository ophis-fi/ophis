import { createStore } from 'jotai'

import { installOtcWebLocksMock } from './otcWebLocks.test.utils'
import {
  coordinatedOtcTransactionAtom,
  recordUncertainOtcTransaction,
  removeUncertainOtcTransaction,
  uncertainOtcTransactionsAtom,
} from './uncertainOtcTransactionsAtom'

const LEGACY = 'ophisOtcUncertainTransactions:v0'
const CURRENT = 'ophisOtcUncertainTransactions:v1'
const HASH = `0x${'aa'.repeat(32)}` as const
const proof = { requestHash: HASH, nonce: 7 }

beforeEach(() => {
  installOtcWebLocksMock()
  localStorage.removeItem(LEGACY)
  localStorage.removeItem(CURRENT)
})

it('migrates known legacy locks without letting old-bundle writes erase a new no-hash marker', async () => {
  localStorage.setItem(LEGACY, JSON.stringify(recordUncertainOtcTransaction({}, 'fork:order', HASH)))
  const store = createStore()
  await store.set(coordinatedOtcTransactionAtom, async (current) => {
    expect(current['fork:order'].transactionHash).toBe(HASH)
    store.set(
      uncertainOtcTransactionsAtom,
      recordUncertainOtcTransaction(current, 'ethereum:create', null, undefined, proof),
    )
  })
  localStorage.setItem(LEGACY, '{}')
  const reopened = createStore()
  await reopened.set(coordinatedOtcTransactionAtom, async (current) => {
    expect(current['fork:order'].transactionHash).toBe(HASH)
    expect(current['ethereum:create']).toMatchObject({ transactionHash: null, proof })
  })
})

it('treats an explicitly cleared v1 store as authoritative instead of resurrecting legacy locks', async () => {
  localStorage.setItem(LEGACY, JSON.stringify(recordUncertainOtcTransaction({}, 'fork:order', HASH)))
  localStorage.setItem(CURRENT, '{}')
  await createStore().set(coordinatedOtcTransactionAtom, async (current) => {
    expect(current).toEqual({})
  })
})

it('preserves the reviewed proof when a hash arrives and refuses a stale null-marker clear', () => {
  const unknown = recordUncertainOtcTransaction({}, 'ethereum:create', null, 1, proof)
  const known = recordUncertainOtcTransaction(unknown, 'ethereum:create', HASH, 2)
  expect(known['ethereum:create'].attemptId).toBe(unknown['ethereum:create'].attemptId)
  expect(known['ethereum:create']).toMatchObject({ transactionHash: HASH, proof })
  expect(removeUncertainOtcTransaction(known, 'ethereum:create', null)).toBe(known)
  expect(removeUncertainOtcTransaction(known, 'ethereum:create', HASH)).toEqual({})
})
