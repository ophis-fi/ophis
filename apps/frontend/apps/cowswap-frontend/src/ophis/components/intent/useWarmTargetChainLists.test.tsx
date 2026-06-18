import { ReactNode, Suspense } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { fetchTokenList, listsStatesByChainAtom } from '@cowprotocol/tokens'

import { renderHook, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'

import { useWarmTargetChainLists } from './useWarmTargetChainLists'

// Mock only fetchTokenList; keep the real atoms so the jotai store drives the hook.
jest.mock('@cowprotocol/tokens', () => ({
  ...jest.requireActual('@cowprotocol/tokens'),
  fetchTokenList: jest.fn(),
}))

const BASE = 8453 as SupportedChainId
const mockFetchTokenList = fetchTokenList as jest.Mock

function makeList(source: string) {
  return {
    source,
    list: {
      name: source,
      tokens: [{ chainId: BASE, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, name: 'USD Coin' }],
    },
  }
}

function wrapperFor(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <Suspense fallback={null}>{children}</Suspense>
    </Provider>
  )
}

describe('useWarmTargetChainLists', () => {
  beforeEach(() => mockFetchTokenList.mockReset())

  it('warms a cold target chain: fetches its default lists and upserts them as enabled', async () => {
    mockFetchTokenList.mockImplementation((src: { source: string }) => Promise.resolve(makeList(src.source)))
    const store = createStore()
    // Seed the IDB-backed atom so it resolves synchronously in jsdom (no Suspense);
    // empty = the Base slot is cold, which is what we want to warm.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.set(listsStatesByChainAtom, {} as any)

    renderHook(() => useWarmTargetChainLists(BASE), { wrapper: wrapperFor(store) })

    // It fetched the chain's default sources.
    await waitFor(() => expect(mockFetchTokenList).toHaveBeenCalled())

    // The fetched lists landed in the Base slot, each marked enabled (required for
    // cross-chain resolution to not filter them out).
    await waitFor(async () => {
      const slot = (await store.get(listsStatesByChainAtom))[BASE]
      const entries = Object.values(slot || {})
      expect(entries.length).toBeGreaterThan(0)
      entries.forEach((ls) => expect((ls as { isEnabled?: boolean }).isEnabled).toBe(true))
    })
  })

  it('does NOT override a list the user toggled while the warm fetch was in flight (race)', async () => {
    // Codex 2026-06-18: cold-check passes -> fetch starts -> user disables a Base list ->
    // fetch resolves. The warm must re-check and skip, not re-enable the user's disabled list.
    let resolveFetch: () => void = () => undefined
    mockFetchTokenList.mockImplementation(
      (src: { source: string }) => new Promise((res) => { resolveFetch = () => res(makeList(src.source)) }),
    )
    const store = createStore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.set(listsStatesByChainAtom, {} as any) // cold

    renderHook(() => useWarmTargetChainLists(BASE), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockFetchTokenList).toHaveBeenCalled()) // fetch started (slot was cold)

    // User disables a Base list mid-fetch.
    store.set(listsStatesByChainAtom, {
      [BASE]: { 'user-pick': { source: 'user-pick', isEnabled: false, list: { name: 'u', tokens: [] } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await new Promise((r) => setTimeout(r, 0)) // let the hook re-render so its latest-ref updates

    resolveFetch() // fetch resolves AFTER the user's toggle
    await new Promise((r) => setTimeout(r, 30))

    const slot = (await store.get(listsStatesByChainAtom))[BASE]
    expect(Object.keys(slot)).toEqual(['user-pick']) // warm did NOT add its lists
    expect((slot['user-pick'] as { isEnabled?: boolean }).isEnabled).toBe(false) // toggle preserved
  })

  it('skips a chain whose lists are already loaded (no fetch, no override)', async () => {
    const store = createStore()
    store.set(listsStatesByChainAtom, {
      [BASE]: { existing: { source: 'existing', isEnabled: false, list: { name: 'x', tokens: [] } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    renderHook(() => useWarmTargetChainLists(BASE), { wrapper: wrapperFor(store) })

    await new Promise((r) => setTimeout(r, 50))
    expect(mockFetchTokenList).not.toHaveBeenCalled()
  })

  it('does nothing for an undefined chainId', async () => {
    const store = createStore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.set(listsStatesByChainAtom, {} as any)
    renderHook(() => useWarmTargetChainLists(undefined), { wrapper: wrapperFor(store) })

    await new Promise((r) => setTimeout(r, 50))
    expect(mockFetchTokenList).not.toHaveBeenCalled()
  })
})
