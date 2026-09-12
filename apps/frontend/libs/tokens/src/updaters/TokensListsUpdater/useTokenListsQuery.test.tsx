import { createStore, Provider } from 'jotai'

import { SupportedChainId, mapSupportedNetworks } from '@cowprotocol/cow-sdk'

import { QueryClient } from '@tanstack/query-core'
import { act, render, waitFor } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'

import { useTokenListsQuery } from './useTokenListsQuery'

import { DEFAULT_TOKENS_LISTS } from '../../const/tokensLists'
import { fetchTokenList } from '../../services/fetchTokenList'
import { environmentAtom } from '../../state/environmentAtom'
import { listsStatesByChainAtom } from '../../state/tokenLists/tokenListsStateAtom'
import { activeTokensMapAtom } from '../../state/tokens/allTokensAtom'
import { ListState } from '../../types'

jest.mock('../../services/fetchTokenList')

function Updater(): null {
  useTokenListsQuery()
  return null
}

it('makes TINY selectable with its logo while Pons is pending and preserves it after Pons fails', async () => {
  const chainId = 4663 as SupportedChainId
  const source = DEFAULT_TOKENS_LISTS[chainId].find((list) => list.source.endsWith('/token-lists/robinhood.json'))
  if (!source) throw new Error('Missing Robinhood default token list')
  const token = {
    chainId,
    address: '0xb9CE619b168f325b4eb8C2E8E073501838C7A407',
    name: 'Tiny Humans AI',
    symbol: 'TINY',
    decimals: 18,
    logoURI: 'https://swap.ophis.fi/logos/token-tiny.png',
  }
  const tinyList: ListState = {
    ...source,
    list: {
      name: 'Ophis Robinhood Tokens',
      timestamp: '2026-09-12T09:00:00Z',
      version: { major: 1, minor: 0, patch: 0 },
      tokens: [token],
    },
  }
  let rejectPons: (reason: Error) => void = () => undefined
  const pons = new Promise<ListState>((_resolve, reject) => {
    rejectPons = reject
  })
  jest
    .mocked(fetchTokenList)
    .mockImplementation((list) => (list.source === source.source ? Promise.resolve(tinyList) : pons))
  const store = createStore()
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  store.set(queryClientAtom, client)
  store.set(environmentAtom, { chainId })
  store.set(listsStatesByChainAtom, mapSupportedNetworks({}))
  const view = render(
    <Provider store={store}>
      <Updater />
    </Provider>,
  )
  try {
    await waitFor(async () => {
      const tokens = await store.get(activeTokensMapAtom)
      expect(tokens[token.address.toLowerCase()]).toEqual(
        expect.objectContaining({ symbol: 'TINY', logoURI: token.logoURI }),
      )
    })
    await act(async () => {
      rejectPons(new Error('Pons unavailable'))
    })
    await waitFor(() => expect(client.isFetching()).toBe(0))
    expect((await store.get(activeTokensMapAtom))[token.address.toLowerCase()]?.symbol).toBe('TINY')
  } finally {
    view.unmount()
    client.clear()
  }
})
