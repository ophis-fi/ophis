import { createStore } from 'jotai/vanilla'

import { installOtcWebLocksMock } from './otcWebLocks.test.utils'
import {
  coordinatedOtcTransactionAtom,
  recordUncertainOtcTransaction,
  removeUncertainOtcTransaction,
  uncertainOtcTransactionsAtom,
} from './uncertainOtcTransactionsAtom'

const STORAGE_KEY = 'ophisOtcUncertainTransactions:v0'
const HASH_A = `0x${'ab'.repeat(32)}` as const
const HASH_B = `0x${'cd'.repeat(32)}` as const

function dispatchStorageChange(): void {
  const event = new Event('storage')
  Object.defineProperties(event, {
    key: { value: STORAGE_KEY },
    newValue: { value: localStorage.getItem(STORAGE_KEY) },
    storageArea: { value: localStorage },
  })
  window.dispatchEvent(event)
}

describe('uncertain OTC transaction locks across browser tabs', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    installOtcWebLocksMock()
  })

  it('propagates a broadcast lock to an already mounted tab', () => {
    const firstTab = createStore()
    const secondTab = createStore()
    const stopFirst = firstTab.sub(uncertainOtcTransactionsAtom, () => undefined)
    const stopSecond = secondTab.sub(uncertainOtcTransactionsAtom, () => undefined)
    try {
      firstTab.set(uncertainOtcTransactionsAtom, (current) =>
        recordUncertainOtcTransaction(current, 'fork-a:order', HASH_A),
      )
      dispatchStorageChange()

      expect(secondTab.get(uncertainOtcTransactionsAtom)['fork-a:order']?.transactionHash).toBe(HASH_A)
    } finally {
      stopFirst()
      stopSecond()
    }
  })

  it('keeps another tab’s uncertain transaction persisted after an unrelated transaction settles', () => {
    const firstTab = createStore()
    const secondTab = createStore()
    const stopFirst = firstTab.sub(uncertainOtcTransactionsAtom, () => undefined)
    const stopSecond = secondTab.sub(uncertainOtcTransactionsAtom, () => undefined)
    try {
      firstTab.set(uncertainOtcTransactionsAtom, (current) =>
        recordUncertainOtcTransaction(current, 'fork-a:order', HASH_A),
      )
      dispatchStorageChange()
      secondTab.set(uncertainOtcTransactionsAtom, (current) =>
        recordUncertainOtcTransaction(current, 'fork-b:order', HASH_B),
      )
      secondTab.set(uncertainOtcTransactionsAtom, (current) =>
        removeUncertainOtcTransaction(current, 'fork-b:order', HASH_B),
      )
      dispatchStorageChange()

      expect(localStorage.getItem(STORAGE_KEY)).toContain(HASH_A)
    } finally {
      stopFirst()
      stopSecond()
    }
  })

  it('preserves another broadcast when a stale tab settles before receiving storage events', async () => {
    const firstTab = createStore()
    const secondTab = createStore()
    const stopFirst = firstTab.sub(uncertainOtcTransactionsAtom, () => undefined)
    const stopSecond = secondTab.sub(uncertainOtcTransactionsAtom, () => undefined)
    try {
      await firstTab.set(coordinatedOtcTransactionAtom, async () => {
        firstTab.set(uncertainOtcTransactionsAtom, (current) =>
          recordUncertainOtcTransaction(current, 'fork-a:order', HASH_A),
        )
      })
      expect(secondTab.get(uncertainOtcTransactionsAtom)).toEqual({})
      await secondTab.set(coordinatedOtcTransactionAtom, async () => {
        secondTab.set(uncertainOtcTransactionsAtom, (current) =>
          recordUncertainOtcTransaction(current, 'fork-b:order', HASH_B),
        )
        secondTab.set(uncertainOtcTransactionsAtom, (current) =>
          removeUncertainOtcTransaction(current, 'fork-b:order', HASH_B),
        )
      })

      expect(localStorage.getItem(STORAGE_KEY)).toContain(HASH_A)
      expect(localStorage.getItem(STORAGE_KEY)).not.toContain(HASH_B)
    } finally {
      stopFirst()
      stopSecond()
    }
  })

  it('rejects concurrent actions and recovery until the active operation finishes', async () => {
    const firstTab = createStore()
    const secondTab = createStore()
    const otherOperation = jest.fn()
    let finish = (): void => {
      throw new Error('Lock was not acquired')
    }
    const firstOperation = firstTab.set(
      coordinatedOtcTransactionAtom,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )

    await expect(secondTab.set(coordinatedOtcTransactionAtom, otherOperation)).rejects.toThrow('another tab')
    expect(otherOperation).not.toHaveBeenCalled()
    finish()
    await firstOperation
    await secondTab.set(coordinatedOtcTransactionAtom, otherOperation)
    expect(otherOperation).toHaveBeenCalledTimes(1)
  })

  it('fails closed when native browser coordination is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const operation = jest.fn()
    await expect(createStore().set(coordinatedOtcTransactionAtom, operation)).rejects.toThrow(
      'coordination unavailable',
    )
    expect(operation).not.toHaveBeenCalled()
  })
})
