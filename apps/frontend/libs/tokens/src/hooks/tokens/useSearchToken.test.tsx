import { createStore, PrimitiveAtom, Provider } from 'jotai'
import { ReactNode } from 'react'

import { getRpcProvider, TokenWithLogo } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { QueryClient } from '@tanstack/query-core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'

import { useSearchToken } from './useSearchToken'

import { environmentAtom } from '../../state/environmentAtom'
import { allActiveTokensAtom } from '../../state/tokens/allTokensAtom'
import { fetchTokenFromBlockchain } from '../../utils/fetchTokenFromBlockchain'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  getRpcProvider: jest.fn(),
}))
jest.mock('../../utils/fetchTokenFromBlockchain')
jest.mock('../../state/tokens/allTokensAtom', () => {
  const { atom } = jest.requireActual('jotai')
  return { allActiveTokensAtom: atom({ tokens: [], chainId: 1 }), inactiveTokensAtom: atom([]) }
})

const address = '0x96c645D3D3706f793Ef52C19bBACe441900eD47D'
const metadata = { address, chainId: 1, decimals: 0, symbol: 'MPS', name: 'Mt Pelerin Shares' }

function setup(input: string): ReturnType<typeof renderHook<ReturnType<typeof useSearchToken>, { input: string }>> & {
  store: ReturnType<typeof createStore>
  client: QueryClient
} {
  const store = createStore()
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  store.set(queryClientAtom, client)
  store.set(environmentAtom, { chainId: SupportedChainId.MAINNET })
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => <Provider store={store}>{children}</Provider>
  return { ...renderHook(({ input }) => useSearchToken(input), { initialProps: { input }, wrapper }), store, client }
}

it('looks up addresses without a wallet and scopes cached metadata to the selected network', async () => {
  const provider = {} as ReturnType<typeof getRpcProvider>
  jest.mocked(getRpcProvider).mockReturnValue(provider)
  jest.mocked(fetchTokenFromBlockchain).mockImplementation(async (_address, chainId) => ({ ...metadata, chainId }))
  const view = setup(` ${address} `)
  try {
    await waitFor(() => expect(view.result.current.blockchainResult[0]?.chainId).toBe(1))
    expect(fetchTokenFromBlockchain).toHaveBeenCalledWith(address.toLowerCase(), 1, provider)
    act(() => view.store.set(environmentAtom, { chainId: SupportedChainId.GNOSIS_CHAIN }))
    expect(view.result.current.blockchainResult).toEqual([])
    await waitFor(() => expect(view.result.current.blockchainResult[0]?.chainId).toBe(100))
    expect(getRpcProvider).toHaveBeenLastCalledWith(100)
    expect(fetchTokenFromBlockchain).toHaveBeenLastCalledWith(address.toLowerCase(), 100, provider)
    view.rerender({ input: 'unrelated' })
    expect(view.result.current.blockchainResult).toEqual([])
    await waitFor(() => expect(view.result.current.isLoading).toBe(false), { timeout: 2000 })
  } finally {
    view.unmount()
    view.client.clear()
  }
})

it('finds listed MPS by symbol or address without requiring an RPC lookup or import', async () => {
  const view = setup('MPS')
  const token = TokenWithLogo.fromToken(metadata)
  try {
    // The mocked atom is writable; production exposes this as derived state.
    const writable = allActiveTokensAtom as PrimitiveAtom<{ tokens: TokenWithLogo[]; chainId: number }>
    act(() => view.store.set(writable, { tokens: [token], chainId: 1 }))
    await waitFor(() => expect(view.result.current.activeListsResult).toEqual([token]))
    jest.mocked(fetchTokenFromBlockchain).mockClear()
    view.rerender({ input: address })
    await waitFor(() => expect(view.result.current.activeListsResult).toEqual([token]))
    expect(view.result.current.blockchainResult).toEqual([])
    expect(fetchTokenFromBlockchain).not.toHaveBeenCalled()
  } finally {
    view.unmount()
    view.client.clear()
  }
})
