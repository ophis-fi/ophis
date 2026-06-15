import { createStore, Provider } from 'jotai'
import { ReactNode, Suspense } from 'react'

import { renderHook, waitFor } from '@testing-library/react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { useTokenForChainMapBySymbol } from './useTokenForChainBySymbol'

import { listsStatesByChainAtom } from '../../state/tokenLists/tokenListsStateAtom'
import { TokenListsByChainState } from '../../types'

/**
 * Regression test for the cross-chain resolution path: the intent flow resolves
 * a symbol for the URL's TARGET chain, which is frequently NOT the connected/env
 * chain (e.g. "swap USDC on Base" while the wallet is on Ethereum). The hook must
 * key off its chainId ARGUMENT, never the connected chain.
 *
 * Both chains carry a token symboled "USDC" at DISTINCT addresses, so each lookup
 * is load-bearing: a hook that regressed to reading the connected/env chain
 * (jsdom defaults to Mainnet) would return ETH_USDC for the Base call and fail.
 * (Closes the test gap the PR #608 security review flagged.)
 */
const BASE = 8453 as SupportedChainId
const ETHEREUM = 1 as SupportedChainId
// Distinct USDC addresses per chain (lowercased — lists provide addresses verbatim).
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

function listFor(chainId: SupportedChainId, address: string) {
  const source = `https://list-${chainId}.example/tokens.json`
  return {
    [source]: {
      source,
      priority: 0,
      // isEnabled MUST be explicit-true here: under a fresh store the env chain
      // defaults to Mainnet, so allListsSourcesAtom (which feeds enabledByDefault)
      // only knows Ethereum sources — these synthetic sources would otherwise be
      // treated as disabled and silently turn the assertions into false negatives.
      isEnabled: true,
      list: {
        name: `chain ${chainId} list`,
        tokens: [{ chainId, address, symbol: 'USDC', decimals: 6, name: 'USD Coin' }],
      },
    },
  }
}

function storeWithBothChains(): ReturnType<typeof createStore> {
  const store = createStore()
  store.set(listsStatesByChainAtom, {
    [ETHEREUM]: listFor(ETHEREUM, ETH_USDC),
    [BASE]: listFor(BASE, BASE_USDC),
  } as unknown as TokenListsByChainState)
  return store
}

// Suspense boundary: the hook reads idb-backed atoms (listsStatesByChainAtom,
// allListsSourcesAtom) which hydrate asynchronously on mount in the test env, so
// we let them settle via waitFor instead of asserting on a transiently-suspended
// render. (In production these atoms are already hydrated.)
function wrapperFor(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <Suspense fallback={null}>{children}</Suspense>
    </Provider>
  )
}

describe('useTokenForChainMapBySymbol (cross-chain: resolves by chainId argument, not the connected chain)', () => {
  // Load-bearing guard: both chains are seeded with a distinct USDC address, so a
  // hook that regressed to reading the env/connected chain (Mainnet) instead of its
  // argument would return ETH_USDC for the Base call and FAIL here.
  it('resolves the TARGET chain token (Base) even though the env/connected chain is Mainnet', async () => {
    const { result } = renderHook(() => useTokenForChainMapBySymbol(BASE), {
      wrapper: wrapperFor(storeWithBothChains()),
    })
    await waitFor(() => expect(result.current?.['usdc']?.address).toBe(BASE_USDC))
  })

  // With both chains present, the Ethereum argument must resolve Ethereum's USDC,
  // not Base's — each call gets only its own chain's token.
  it('resolves the Ethereum token for the Ethereum argument', async () => {
    const { result } = renderHook(() => useTokenForChainMapBySymbol(ETHEREUM), {
      wrapper: wrapperFor(storeWithBothChains()),
    })
    await waitFor(() => expect(result.current?.['usdc']?.address).toBe(ETH_USDC))
  })
})
