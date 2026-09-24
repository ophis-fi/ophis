import { createJSONStorage } from 'jotai/utils'

// TODO(2027-03-25): Remove v1 compatibility only once old bundles are retired
// and pending v1 journals retain a supported recovery path.
// Retain the burn intent BEFORE requesting a signature. A wallet transport error
// can occur after broadcast; an unknown outcome must never trigger a second burn.
export const CCTP_STORAGE_KEY = 'cctpTransfer:v2'
const legacyKey = 'cctpTransfer:v1'
const jsonStorage = createJSONStorage<unknown>()
// Read old USDC journals in place; migrate on the first locked update, never
// during hydration. A legacy guard prevents old tabs from starting another burn.
export const cctpStorage: typeof jsonStorage = {
  getItem: (key, initialValue) => jsonStorage.getItem(key, null) ?? jsonStorage.getItem(legacyKey, initialValue),
  setItem: (key, value) => {
    if (value === null) {
      jsonStorage.setItem(legacyKey, null)
      jsonStorage.setItem(key, null)
    } else {
      jsonStorage.setItem(key, value)
      const guard = { version: 2, recoveryKey: CCTP_STORAGE_KEY }
      jsonStorage.setItem(legacyKey, guard)
      if (JSON.stringify(jsonStorage.getItem(legacyKey, null)) !== JSON.stringify(guard))
        throw new Error('Unable to protect bridge recovery from an older tab. Nothing was signed.')
    }
  },
  removeItem: (key) => cctpStorage.setItem(key, null),
  subscribe: (key, callback, initialValue) => {
    const changed = (): void => callback(cctpStorage.getItem(key, initialValue))
    const current = jsonStorage.subscribe?.(key, changed, initialValue)
    const legacy = jsonStorage.subscribe?.(legacyKey, changed, initialValue)
    return () => {
      current?.()
      legacy?.()
    }
  },
}
