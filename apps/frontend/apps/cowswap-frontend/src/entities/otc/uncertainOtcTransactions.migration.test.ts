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
    store.set(uncertainOtcTransactionsAtom, {
      ...current,
      'ethereum:create': { transactionHash: null, recordedAt: 1, proof },
    })
  })
  localStorage.setItem(LEGACY, '{}')
  const reopened = createStore()
  await reopened.set(coordinatedOtcTransactionAtom, async (current) => {
    expect(current['fork:order'].transactionHash).toBe(HASH)
    expect(current['ethereum:create']).toMatchObject({ transactionHash: null, proof })
  })
})

it('mirrors known locks and their removal for legacy bundles', async () => {
  const store = createStore()
  await store.set(coordinatedOtcTransactionAtom, async () => {
    store.set(uncertainOtcTransactionsAtom, recordUncertainOtcTransaction({}, 'fork:order', HASH))
  })
  expect(JSON.parse(localStorage.getItem(LEGACY) ?? '{}')['fork:order'].transactionHash).toBe(HASH)
  await store.set(coordinatedOtcTransactionAtom, async (current) => {
    store.set(uncertainOtcTransactionsAtom, removeUncertainOtcTransaction(current, 'fork:order', HASH))
  })
  expect(localStorage.getItem(LEGACY)).toBe('{}')
  expect(localStorage.getItem(CURRENT)).toBe('{}')
})

it('imports an old-bundle known lock written after v1 already exists', async () => {
  localStorage.setItem(CURRENT, '{}')
  localStorage.setItem(LEGACY, JSON.stringify(recordUncertainOtcTransaction({}, 'fork:order', HASH)))
  await createStore().set(coordinatedOtcTransactionAtom, async (current) => {
    expect(current['fork:order'].transactionHash).toBe(HASH)
  })
})

it('preserves the reviewed proof when a hash arrives and refuses a stale null-marker clear', () => {
  const unknown = { 'ethereum:create': { transactionHash: null, recordedAt: 1, proof, attemptId: '1-2-3-4' } }
  const known = recordUncertainOtcTransaction(unknown, 'ethereum:create', HASH, 2)
  expect(known['ethereum:create'].attemptId).toBe(unknown['ethereum:create'].attemptId)
  expect(known['ethereum:create']).toMatchObject({ transactionHash: HASH, proof })
  expect(removeUncertainOtcTransaction(known, 'ethereum:create', null)).toBe(known)
  expect(removeUncertainOtcTransaction(known, 'ethereum:create', HASH)).toEqual({})
})

it('does not clear a newer legacy hash through a stale v1 record', async () => {
  const otherHash = `0x${'bb'.repeat(32)}` as const
  localStorage.setItem(CURRENT, JSON.stringify(recordUncertainOtcTransaction({}, 'fork:order', HASH)))
  localStorage.setItem(LEGACY, JSON.stringify(recordUncertainOtcTransaction({}, 'fork:order', otherHash)))
  const store = createStore()
  await store.set(coordinatedOtcTransactionAtom, async (current) => {
    store.set(uncertainOtcTransactionsAtom, removeUncertainOtcTransaction(current, 'fork:order', HASH))
  })
  expect(JSON.parse(localStorage.getItem(LEGACY) ?? '{}')['fork:order'].transactionHash).toBe(otherHash)
  expect(store.get(uncertainOtcTransactionsAtom)['fork:order'].transactionHash).toBe(otherHash)
})
