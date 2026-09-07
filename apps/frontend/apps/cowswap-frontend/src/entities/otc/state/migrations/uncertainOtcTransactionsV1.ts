import type { UncertainOtcTransactions } from '../../uncertainOtcTransactionsAtom'
import type { SyncStorage } from 'jotai/vanilla/utils/atomWithStorage'

// TODO(2026-12-07): retire v0 mirroring after legacy fork-only bundles are no longer supported.
export function migrateUncertainOtcStorage(
  storage: SyncStorage<UncertainOtcTransactions>,
  legacyKey: string,
): SyncStorage<UncertainOtcTransactions> {
  const migrated: SyncStorage<UncertainOtcTransactions> = {
    ...storage,
    getItem: (key, initial) => {
      const legacy = storage.getItem(legacyKey, initial)
      const current = { ...legacy, ...storage.getItem(key, initial) }
      for (const [context, attempt] of Object.entries(legacy)) {
        // A legacy tab may resolve A and broadcast B while v1 still contains A.
        if (current[context].transactionHash !== null && current[context].transactionHash !== attempt.transactionHash)
          current[context] = attempt
      }
      return current
    },
    setItem: (key, value) => {
      // Old validators only accept known hashes. They cannot perform canary writes.
      const known = Object.fromEntries(Object.entries(value).filter(([, attempt]) => attempt.transactionHash !== null))
      storage.setItem(legacyKey, known)
      storage.setItem(key, value)
    },
    subscribe: (key, callback, initial) => {
      const changed = (): void => callback(migrated.getItem(key, initial))
      const stopCurrent = storage.subscribe?.(key, changed, initial)
      const stopLegacy = storage.subscribe?.(legacyKey, changed, initial)
      return () => {
        stopCurrent?.()
        stopLegacy?.()
      }
    },
  }
  return migrated
}
