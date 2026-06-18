import { useEffect, useRef } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { DEFAULT_TOKENS_LISTS, fetchTokenList, listsStatesByChainAtom, upsertListsAtom } from '@cowprotocol/tokens'
import type { ListState } from '@cowprotocol/tokens'

import { useAtomValue, useSetAtom } from 'jotai'

/**
 * Pre-load the intent's TARGET chain token lists so the CTA can emit token
 * ADDRESSES (not bare symbols) in the swap URL.
 *
 * Why: intentToUrl resolves each token symbol to an on-chain address via
 * useTokenForChainMapBySymbol(targetChainId). An address fills the swap form
 * reliably (it bypasses the ambiguous-symbol reset, e.g. USDC vs USDC.e), whereas
 * a bare symbol on a cold chain clears the pair. But the resolver only sees a chain
 * whose lists are loaded into listsStatesByChainAtom, and on the landing only the
 * connected/source chain's lists are loaded - so a chain named in the intent
 * ("...on Base") resolves to nothing and intentToUrl falls back to the bare symbol.
 *
 * This hook fetches the target chain's enabled-by-default lists and upserts them so
 * they are loaded by the time the user clicks Continue. Best-effort: on failure, or
 * if it loses the race with the click, intentToUrl falls back to the bare symbol
 * exactly as before (graceful degradation, never worse than today).
 *
 * isEnabled:true is REQUIRED, not cosmetic. useTokenForChainMapBySymbol derives a
 * list's enabled-by-default flag from allListsSourcesAtom, which is scoped to the
 * CONNECTED chain - so a warmed list for a DIFFERENT chain would be treated as
 * disabled and filtered out unless its isEnabled is explicit-true. (This mirrors the
 * setup in useTokenForChainBySymbol.crosschain.test.tsx.)
 *
 * Cold-only: skipped when the chain's slot already has entries (loaded this session
 * or hydrated from IndexedDB on a return visit), so it never re-fetches and never
 * overrides a list a returning user explicitly toggled.
 */
export function useWarmTargetChainLists(chainId: SupportedChainId | undefined): void {
  const listsStatesByChain = useAtomValue(listsStatesByChainAtom)
  const upsertLists = useSetAtom(upsertListsAtom)
  const requested = useRef<Set<number>>(new Set())
  // Always-fresh view of the per-chain lists, so the async upsert below can re-check the
  // slot at RESOLVE time (the effect closure's value is stale by then). Updated each render.
  const latestByChain = useRef(listsStatesByChain)
  latestByChain.current = listsStatesByChain

  useEffect(() => {
    if (!chainId || requested.current.has(chainId)) return

    const slot = listsStatesByChain[chainId]
    if (slot && Object.keys(slot).length > 0) return // already loaded (session or IDB) - nothing to do

    const sources = (DEFAULT_TOKENS_LISTS[chainId] || []).filter((source) => source.enabledByDefault)
    if (sources.length === 0) return

    requested.current.add(chainId)

    Promise.allSettled(sources.map(fetchTokenList))
      .then((results) => {
        // Re-check at WRITE time: if the user toggled a list (or the chain otherwise
        // loaded) while we were fetching, do NOT override their state (Codex 2026-06-18).
        const current = latestByChain.current[chainId]
        if (current && Object.keys(current).length > 0) return

        const lists = results
          .filter((result): result is PromiseFulfilledResult<ListState> => result.status === 'fulfilled')
          .map((result) => ({ ...result.value, isEnabled: true }))

        if (lists.length > 0) upsertLists(chainId, lists)
      })
      .catch(() => {
        // Best-effort: on failure the URL falls back to the bare symbol (pre-fix behavior).
      })
  }, [chainId, listsStatesByChain, upsertLists])
}
