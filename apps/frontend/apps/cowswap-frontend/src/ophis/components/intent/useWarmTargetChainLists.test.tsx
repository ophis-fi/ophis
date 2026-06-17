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
