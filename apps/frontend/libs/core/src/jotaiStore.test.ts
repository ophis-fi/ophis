import { createJSONStorage } from 'jotai/utils'

import { AsyncStorage, SyncStorage } from 'jotai/vanilla/utils/atomWithStorage'

import { withStorageGuard } from './jotaiStore'

describe('withStorageGuard', () => {
  type Shape = { kind: 'good'; count: number }
  const isShape = (v: unknown): v is Shape =>
    !!v && typeof v === 'object' && (v as Shape).kind === 'good' && typeof (v as Shape).count === 'number'

  const initial: Shape = { kind: 'good', count: 0 }

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('sync storage', () => {
    function makeSync(value: unknown): SyncStorage<Shape> {
      return {
        getItem: (_k, _init) => value as Shape,
        setItem: () => undefined,
        removeItem: () => undefined,
      }
    }

    it('passes through a valid value', () => {
      const guarded = withStorageGuard(makeSync({ kind: 'good', count: 7 }), isShape, 'test')
      expect(guarded.getItem('k', initial)).toEqual({ kind: 'good', count: 7 })
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('falls back to initial on shape mismatch', () => {
      const guarded = withStorageGuard(makeSync({ kind: 'BAD', count: 'string-not-number' }), isShape, 'test')
      expect(guarded.getItem('k', initial)).toEqual(initial)
      expect(console.warn).toHaveBeenCalledTimes(1)
    })

    it('falls back to initial on null', () => {
      const guarded = withStorageGuard(makeSync(null), isShape, 'test')
      expect(guarded.getItem('k', initial)).toEqual(initial)
      expect(console.warn).toHaveBeenCalledTimes(1)
    })

    it('deduplicates the warning across multiple calls', () => {
      const guarded = withStorageGuard(makeSync({ wrong: 'shape' }), isShape, 'test')
      guarded.getItem('k', initial)
      guarded.getItem('k', initial)
      guarded.getItem('k', initial)
      expect(console.warn).toHaveBeenCalledTimes(1)
    })

    it('preserves setItem / removeItem from the underlying storage', () => {
      const setItem = jest.fn()
      const removeItem = jest.fn()
      const storage: SyncStorage<Shape> = {
        getItem: () => initial,
        setItem,
        removeItem,
      }
      const guarded = withStorageGuard(storage, isShape, 'test')
      guarded.setItem('k', initial)
      guarded.removeItem('k')
      expect(setItem).toHaveBeenCalledWith('k', initial)
      expect(removeItem).toHaveBeenCalledWith('k')
    })
  })

  describe('async storage', () => {
    function makeAsync(value: unknown): AsyncStorage<Shape> {
      return {
        getItem: () => Promise.resolve(value as Shape),
        setItem: () => Promise.resolve(),
        removeItem: () => Promise.resolve(),
      }
    }

    it('passes through a valid value (resolved promise)', async () => {
      const guarded = withStorageGuard(makeAsync({ kind: 'good', count: 9 }), isShape, 'test-async')
      await expect(guarded.getItem('k', initial)).resolves.toEqual({ kind: 'good', count: 9 })
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('falls back to initial on shape mismatch (resolved promise)', async () => {
      const guarded = withStorageGuard(makeAsync({ wrong: 'shape' }), isShape, 'test-async')
      await expect(guarded.getItem('k', initial)).resolves.toEqual(initial)
      expect(console.warn).toHaveBeenCalledTimes(1)
    })
  })

  it('integrates with createJSONStorage + a real-ish localStorage', () => {
    const store: Record<string, string> = {}
    const fakeLs: Storage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        store[k] = v
      },
      removeItem: (k) => {
        delete store[k]
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      },
      key: (i) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length
      },
    }

    // Poison the storage with garbage.
    store['my-key'] = JSON.stringify({ rogue: true })

    const guarded = withStorageGuard(
      createJSONStorage<Shape>(() => fakeLs),
      isShape,
      'integration',
    )
    const result = guarded.getItem('my-key', initial)
    expect(result).toEqual(initial)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
