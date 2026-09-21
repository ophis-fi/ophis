import { atom } from 'jotai'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import {
  listsEnabledStateAtom,
  listsStatesByChainAtom,
  listsStatesMapAtom,
  userAddedListsSourcesAtom,
} from './tokenListsStateAtom'

import { DEFAULT_TOKENS_LISTS, OPHIS_TOKENS_LIST_SOURCE } from '../../const/tokensLists'
import { ListState } from '../../types'
import { environmentAtom } from '../environmentAtom'
import { migrateOphisTokenList } from '../migrations/migrateOphisTokenList'

export const upsertListsAtom = atom(null, (get, set, chainId: SupportedChainId, listsStates: ListState[]) =>
  set(listsStatesByChainAtom, async (previous) => {
    const globalState = await previous
    const retainedSources = new Set([
      ...(DEFAULT_TOKENS_LISTS[chainId] || []).map(({ source }) => source),
      ...(get(userAddedListsSourcesAtom)[chainId] || []).map(({ source }) => source),
      ...(Array.isArray(get(environmentAtom).selectedLists) ? get(environmentAtom).selectedLists || [] : []),
    ])
    const chainState = listsStates.some(({ source }) => source === OPHIS_TOKENS_LIST_SOURCE)
      ? migrateOphisTokenList(chainId, globalState[chainId], retainedSources)
      : globalState[chainId]

    const update = listsStates.reduce<{ [listId: string]: ListState }>((acc, list) => {
      const listState = chainState?.[list.source]
      // A periodic refresh has no explicit enabled state and must preserve an
      // explicit removal. User-driven adds carry `isEnabled: true` and may
      // intentionally restore the list.
      if (listState === 'deleted' && list.isEnabled !== true) return acc
      const defaultEnabledState = listState === 'deleted' ? true : listState?.isEnabled

      acc[list.source] = {
        ...list,
        isEnabled: typeof list.isEnabled === 'boolean' ? list.isEnabled : defaultEnabledState,
      }

      return acc
    }, {})

    return {
      ...globalState,
      [chainId]: {
        ...chainState,
        ...update,
      },
    }
  }),
)
export const addListAtom = atom(null, (get, set, state: ListState) => {
  const { chainId, widgetAppCode } = get(environmentAtom)
  const userAddedTokenLists = get(userAddedListsSourcesAtom)
  const userAddedTokenListsForChain = userAddedTokenLists[chainId] || []

  state.isEnabled = true

  if (widgetAppCode) {
    state.widgetAppCode = widgetAppCode
  }

  set(userAddedListsSourcesAtom, {
    ...userAddedTokenLists,
    [chainId]: userAddedTokenListsForChain.concat({
      widgetAppCode: state.widgetAppCode,
      priority: state.priority,
      source: state.source,
    }),
  })

  set(upsertListsAtom, chainId, [state])
})

export const removeListAtom = atom(null, async (get, set, source: string) => {
  const { chainId } = get(environmentAtom)
  const userAddedTokenLists = get(userAddedListsSourcesAtom)
  const userAddedTokenListsForChain = userAddedTokenLists[chainId] || []

  set(userAddedListsSourcesAtom, {
    ...userAddedTokenLists,
    [chainId]: userAddedTokenListsForChain.filter((item) => item.source !== source),
  })

  const stateCopy = { ...(await get(listsStatesByChainAtom)) }

  const networkState = stateCopy[chainId]

  if (networkState) {
    networkState[source] = 'deleted'
  }

  set(listsStatesByChainAtom, stateCopy)
})

export const toggleListAtom = atom(null, async (get, set, source: string) => {
  const { chainId } = get(environmentAtom)
  const listsEnabledState = await get(listsEnabledStateAtom)
  const states = await get(listsStatesMapAtom)

  if (!states[source]) return

  const list = { ...states[source] }

  list.isEnabled = !listsEnabledState[source]

  set(upsertListsAtom, chainId, [list])
})
