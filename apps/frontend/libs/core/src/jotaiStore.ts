import { atomWithStorage, createJSONStorage } from 'jotai/utils'
import { createStore } from 'jotai/vanilla'

import { AsyncStorage, AsyncStringStorage, SyncStorage } from 'jotai/vanilla/utils/atomWithStorage'
import { createInstance } from 'localforage'

export const jotaiStore = createStore()

export const localForageJotai = createInstance({
  name: 'cowswap_jotai',
})

/**
 * atomWithStorage() has built-in feature to persist state between all tabs
 * To disable this feature we pass our own instance of storage
 * https://github.com/pmndrs/jotai/pull/1004/files
 *
 * Important!
 * In jotai@2.x they changed the fix above, and now we have to patch the subscribe method
 */
// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const getJotaiIsolatedStorage = <T>() => {
  const storage = createJSONStorage<T>(() => localStorage)

  storage.subscribe = () => () => void 0

  return storage
}

/**
 * Creates a new jotai json storage which merges the existing local storage with given state
 *
 * By default, jotai returns the initial state when localStorage is unset
 * When it's set, though, it takes precedence, even if it doesn't contain info in the initial state.
 * This is why we merge the initial state with the localStorage info.
 *
 * Based on https://github.com/pmndrs/jotai/discussions/1357
 *
 * @returns jotai json storage with merged localStorage info and initial state.
 */
// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function getJotaiMergerStorage<T>() {
  const storage = createJSONStorage<T>(() => localStorage)

  // TODO: Add proper return type annotation
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function getItem(key: string, initial: T) {
    const value = storage.getItem(key, initial)

    // `initial` comes first, as existing `value` should take precedence
    return { ...initial, ...value }
  }

  return { ...storage, getItem }
}

/**
 * Wrap a Jotai JSONStorage with a runtime shape validator. Hydrated values
 * that don't match the validator are dropped and replaced with the atom's
 * initial value; a single deduplicated `console.warn` per label surfaces the
 * corruption signal in DevTools / Sentry while users see graceful degradation.
 *
 * Why we need this even though TypeScript says the type is safe:
 * - Browser-extension blobs can corrupt localStorage at any time.
 * - Schema drift across deploys (added/removed fields, renamed enums) can
 *   leave old values that look the right shape to JSON.parse but break
 *   strict downstream consumers — e.g. CurrencyAmount.fromRawAmount throws
 *   on an empty `amount` string; `.filter(x => x !== id)` throws on
 *   non-array storage; `Object.keys(state)` throws on null.
 * - One bad entry in a persisted dict atom previously bricked the whole
 *   render tree (Phase 4 audit findings H1/H2/H3/H6/H7 → 2026-05-21).
 *
 * Pair with the strictest validator you can write: prefer hard shape checks
 * (typeof, Array.isArray, regex on numeric strings) over "is object?" — a
 * loose validator gives false confidence.
 *
 * NOTE: this wraps the SYNC localStorage path. For the async IDB path
 * (atomWithIdbStorage) the same idea applies but the resolved value is a
 * Promise — handled by branching on Promise-shape.
 */
export function withStorageGuard<T>(
  storage: SyncStorage<T>,
  validate: (value: unknown) => value is T,
  label: string,
): SyncStorage<T>
export function withStorageGuard<T>(
  storage: AsyncStorage<T>,
  validate: (value: unknown) => value is T,
  label: string,
): AsyncStorage<T>
export function withStorageGuard<T>(
  storage: SyncStorage<T> | AsyncStorage<T>,
  validate: (value: unknown) => value is T,
  label: string,
): SyncStorage<T> | AsyncStorage<T> {
  let warned = false

  const warn = (): void => {
    if (warned) return
    warned = true

    console.warn(
      `[withStorageGuard:${label}] persisted value failed validation; replacing with initial. ` +
        `Likely browser-extension corruption or schema drift from a prior deploy.`,
    )
  }

  const guardedGetItem = (key: string, initial: T): T | PromiseLike<T> => {
    const result = storage.getItem(key, initial)

    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as PromiseLike<T>).then((resolved: unknown) => {
        if (validate(resolved)) return resolved
        warn()
        return initial
      })
    }

    if (validate(result as unknown)) return result as T
    warn()
    return initial
  }

  // Preserve setItem/removeItem/subscribe by spreading; only override getItem.
  // The overload signatures above ensure the returned storage type matches the
  // input (sync stays sync, async stays async), which is what `atomWithStorage`
  // discriminates on at compile time.
  return {
    ...(storage as object),
    getItem: guardedGetItem,
  } as SyncStorage<T> | AsyncStorage<T>
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function atomWithIdbStorage<Value>(
  key: string,
  initialValue: Value,
  validate?: (value: unknown) => value is Value,
) {
  const storage: AsyncStringStorage = {
    async getItem(key: string): Promise<string | null> {
      return localForageJotai.getItem(key).then((result) => result as string | null)
    },
    async setItem(key: string, newValue: string): Promise<void> {
      await localForageJotai.setItem(key, newValue)
    },
    async removeItem(key: string): Promise<void> {
      await localForageJotai.removeItem(key)
    },
  }

  const jsonStorage = createJSONStorage<Value>(() => storage)

  return atomWithStorage<Value>(
    key,
    initialValue,
    validate ? withStorageGuard<Value>(jsonStorage, validate, key) : jsonStorage,
    { getOnInit: true },
  )
}
