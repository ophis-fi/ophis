import { createStore } from 'jotai'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { OPHIS_TOKENS_LIST_SOURCE } from '../../const/tokensLists'
import { ListState } from '../../types'
import { environmentAtom } from '../environmentAtom'
import { upsertListsAtom } from '../tokenLists/tokenListsActionsAtom'
import { listsStatesByChainAtom, userAddedListsSourcesAtom } from '../tokenLists/tokenListsStateAtom'
import { activeTokensMapAtom } from '../tokens/allTokensAtom'

const COW_SOURCE = 'https://files.cow.fi/tokens/CowSwap.json'
const token = {
  chainId: 1,
  address: '0x0000000000000000000000000000000000000001',
  symbol: 'TEST',
  name: 'Test',
  decimals: 18,
}
const fresh: ListState = {
  source: OPHIS_TOKENS_LIST_SOURCE,
  priority: 1,
  list: {
    name: 'Ophis Token List',
    timestamp: '2026-09-21T00:00:00Z',
    version: { major: 1, minor: 0, patch: 0 },
    tokens: [],
  },
}

describe('Ophis list migration during successful upsert', () => {
  it.each([true, false])('keeps offline tokens with malformed saved sources and enabled=%s', async (isEnabled) => {
    const store = createStore()
    const old = { ...fresh, source: COW_SOURCE, isEnabled, list: { ...fresh.list, tokens: [token] } }
    store.set(userAddedListsSourcesAtom, JSON.parse('{"1":[{}]}'))
    store.set(environmentAtom, { chainId: SupportedChainId.MAINNET, selectedLists: JSON.parse('[null, 42]') })
    store.set(listsStatesByChainAtom, { 1: { [COW_SOURCE]: old } })
    expect(!!(await store.get(activeTokensMapAtom))[token.address]).toBe(isEnabled)
    expect((await store.get(listsStatesByChainAtom))[1]?.[OPHIS_TOKENS_LIST_SOURCE]).toEqual({
      ...old,
      source: OPHIS_TOKENS_LIST_SOURCE,
    })
  })

  it('retains and activates a lowercased widget-selected legacy URL after migration', async () => {
    const store = createStore()
    const old = { ...fresh, source: COW_SOURCE, list: { ...fresh.list, tokens: [token] } }
    store.set(environmentAtom, {
      chainId: SupportedChainId.MAINNET,
      widgetAppCode: 'widget',
      selectedLists: [COW_SOURCE.toLowerCase()],
    })
    store.set(listsStatesByChainAtom, { 1: { [COW_SOURCE]: old } })
    await store.set(upsertListsAtom, SupportedChainId.MAINNET, [fresh])
    expect((await store.get(listsStatesByChainAtom))[1]?.[COW_SOURCE]).toEqual(old)
    expect((await store.get(activeTokensMapAtom))[token.address]?.symbol).toBe('TEST')
  })
  it.each([true, false, 'deleted'] as const)(
    'preserves preference %s and the other chain caches',
    async (preference) => {
      const store = createStore()
      const old = preference === 'deleted' ? preference : { ...fresh, source: COW_SOURCE, isEnabled: preference }
      const custom = { ...fresh, source: 'https://example.com/list.json' }
      store.set(listsStatesByChainAtom, {
        1: { [COW_SOURCE]: old, [custom.source]: custom },
        100: { [COW_SOURCE]: old },
      })
      await store.set(upsertListsAtom, SupportedChainId.MAINNET, [fresh])
      const state = await store.get(listsStatesByChainAtom)
      expect(state[1]?.[OPHIS_TOKENS_LIST_SOURCE]).toEqual(
        preference === 'deleted' ? preference : { ...fresh, isEnabled: preference },
      )
      expect(state[1]?.[COW_SOURCE]).toBeUndefined()
      expect(state[1]?.[custom.source]).toEqual(custom)
      expect(state[100]?.[OPHIS_TOKENS_LIST_SOURCE]).toEqual(
        old === 'deleted' ? old : { ...old, source: OPHIS_TOKENS_LIST_SOURCE },
      )
    },
  )

  it('keeps cached preferences before replacement and preserves an explicitly imported CoW list', async () => {
    const store = createStore()
    const old = { ...fresh, source: COW_SOURCE, isEnabled: false }
    store.set(listsStatesByChainAtom, { 1: { [COW_SOURCE]: old } })
    await store.set(upsertListsAtom, SupportedChainId.MAINNET, [])
    expect((await store.get(listsStatesByChainAtom))[1]?.[OPHIS_TOKENS_LIST_SOURCE]).toEqual({
      ...old,
      source: OPHIS_TOKENS_LIST_SOURCE,
    })
    store.set(userAddedListsSourcesAtom, { 1: [{ source: COW_SOURCE }] })
    await store.set(upsertListsAtom, SupportedChainId.MAINNET, [fresh])
    expect((await store.get(listsStatesByChainAtom))[1]?.[COW_SOURCE]).toEqual(old)
  })

  it.each([
    [10, 'https://static.optimism.io/optimism.tokenlist.json', true],
    [130, 'https://ipfs.io/ipns/tokens.uniswap.org', true],
    [4663, 'https://swap.ophis.fi/token-lists/robinhood.json', false],
    [11155111, 'https://files.cow.fi/token-lists/CowSwapSepolia.json', false],
  ] as const)(
    'migrates chain %s without relying on the currently selected chain',
    async (chainId, source, retained) => {
      const store = createStore()
      const old = { ...fresh, source, isEnabled: false }
      store.set(listsStatesByChainAtom, { [chainId]: { [source]: old } })
      await store.set(upsertListsAtom, chainId as SupportedChainId, [fresh])
      const state = (await store.get(listsStatesByChainAtom))[chainId as SupportedChainId]
      expect(state?.[OPHIS_TOKENS_LIST_SOURCE]).toEqual({ ...fresh, isEnabled: false })
      expect(state?.[source]).toEqual(retained ? { ...old, priority: 2 } : undefined)
      // An explicit choice on the new list must win on later refreshes.
      await store.set(upsertListsAtom, chainId as SupportedChainId, [{ ...fresh, isEnabled: true }])
      await store.set(upsertListsAtom, chainId as SupportedChainId, [fresh])
      expect(
        (await store.get(listsStatesByChainAtom))[chainId as SupportedChainId]?.[OPHIS_TOKENS_LIST_SOURCE],
      ).toEqual({ ...fresh, isEnabled: true })
    },
  )
})
