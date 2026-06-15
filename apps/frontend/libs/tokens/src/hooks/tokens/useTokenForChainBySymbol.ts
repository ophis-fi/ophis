import { useMemo } from 'react'

import { getAddress } from '@ethersproject/address'

import {
  NATIVE_CURRENCIES,
  NATIVE_CURRENCY_ADDRESS,
  TokenWithLogo,
  WRAPPED_NATIVE_CURRENCIES,
} from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { TokenInfo } from '@cowprotocol/types'

import { useAtomValue } from 'jotai'

import { allListsSourcesAtom, listsStatesByChainAtom } from '../../state/tokenLists/tokenListsStateAtom'
import { TokensByAddress } from '../../state/tokens/allTokensAtom'
import { ListState } from '../../types'

/**
 * Is a list active for the user? Mirrors listsEnabledStateAtom: the explicit
 * user toggle (`isEnabled`) if set, otherwise the list's `enabledByDefault`
 * (which `ListState` does not carry, so it is supplied via the source map). A
 * source absent from the map is treated as default-off, matching `!!enabledByDefault`.
 */
function isListEnabled(list: ListState, enabledByDefaultBySource: Record<string, boolean>): boolean {
  return typeof list.isEnabled === 'boolean' ? list.isEnabled : !!enabledByDefaultBySource[list.source]
}

/**
 * Priority-ordered by-address token map for a chain, built directly from the
 * chain's list states. Unlike useTokensByAddressMapForChain (which filters only
 * `deleted` lists), this HONORS the list's active state the same way the swap
 * form's active-token map does (isEnabled ?? enabledByDefault), so the intent
 * resolver never emits a token from a list the user disabled OR from a
 * default-off list the UI treats as inactive. Mirrors the primitive's other
 * rules: first-writer-wins per address in priority order, skip the native
 * sentinel, and only keep tokens whose chainId matches.
 */
export function enabledTokensByAddressForChain(
  chainLists: Record<string, ListState | 'deleted'> | undefined,
  chainId: number,
  enabledByDefaultBySource: Record<string, boolean> = {},
): TokensByAddress {
  if (!chainLists) return {}

  const sortedLists = Object.values(chainLists)
    .filter(
      (ls): ls is ListState => ls !== 'deleted' && !!ls.list?.tokens && isListEnabled(ls, enabledByDefaultBySource),
    )
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))

  const map: TokensByAddress = {}
  const nativeKey = NATIVE_CURRENCY_ADDRESS.toLowerCase()
  for (const ls of sortedLists) {
    for (const token of ls.list.tokens) {
      if (token.chainId !== chainId) continue
      const key = token.address.toLowerCase()
      if (map[key] || key === nativeKey) continue
      map[key] = TokenWithLogo.fromToken(token as TokenInfo, token.logoURI)
    }
  }
  return map
}

/**
 * Build a `lowercaseSymbol -> TokenWithLogo` map from a by-address token map.
 *
 * The input is a priority-ordered by-address map (here enabledTokensByAddressForChain;
 * its value-iteration order is priority order, first writer wins per address), so
 * iterating its values and taking the FIRST token per symbol yields the canonical
 * (highest-priority) token for that symbol, mirroring how the swap form resolves
 * an ambiguous symbol.
 *
 * `native` and `wrapped` are injected because that by-address map
 * deliberately skips the native-currency sentinel address: without re-injecting
 * NATIVE_CURRENCIES[chainId] / WRAPPED_NATIVE_CURRENCIES[chainId], "ETH"/"HYPE"
 * (and on some chains "WETH") would never resolve. Native wins its own symbol
 * outright (so "ETH" resolves to the native sentinel, not a stray ERC20 that
 * happens to be symboled ETH); wrapped is only added if the lists didn't
 * already supply it (the list's own wrapped token, same address, is canonical).
 */
export function tokenBySymbolMap(
  byAddress: TokensByAddress,
  native?: TokenWithLogo,
  wrapped?: TokenWithLogo,
): Record<string, TokenWithLogo> {
  const bySymbol: Record<string, TokenWithLogo> = {}

  for (const token of Object.values(byAddress)) {
    if (!token) continue
    const key = token.symbol?.toLowerCase()
    if (key && !(key in bySymbol)) bySymbol[key] = token
  }

  if (wrapped?.symbol) {
    const k = wrapped.symbol.toLowerCase()
    if (!(k in bySymbol)) bySymbol[k] = wrapped
  }
  if (native?.symbol) {
    bySymbol[native.symbol.toLowerCase()] = native
  }

  return bySymbol
}

/**
 * A `symbol -> checksummed-address` resolver over a symbol map. Returns null
 * when the symbol is absent or the address can't be EIP-55 checksummed; the
 * caller then falls back to emitting the bare symbol (never worse than today).
 *
 * The address is checksummed (not passed through verbatim) because Token stores
 * its address exactly as the token list provided it, and a downstream viem
 * strict-mode consumer rejects a mis-cased address at init (see the EIP-55
 * memory rule). Resolution itself is case-insensitive, but the EMITTED address
 * must be canonical.
 */
export function symbolToAddressResolver(bySymbol: Record<string, TokenWithLogo>): (symbol: string) => string | null {
  return (symbol: string) => {
    const token = symbol ? bySymbol[symbol.toLowerCase()] : undefined
    if (!token) return null
    try {
      return getAddress(token.address)
    } catch {
      return null
    }
  }
}

/**
 * Synchronous `lowercaseSymbol -> TokenWithLogo` map for a target chain, so the
 * intent layer can resolve several symbols inside a single navigate callback
 * (React hooks can't be called per-symbol). Works for ANY chain whose token
 * list is loaded, not just the active one.
 */
export function useTokenForChainMapBySymbol(chainId: SupportedChainId | undefined): Record<string, TokenWithLogo> {
  const listsStatesByChain = useAtomValue(listsStatesByChainAtom)
  const listsSources = useAtomValue(allListsSourcesAtom)

  return useMemo(() => {
    if (!chainId) return {}
    const enabledByDefaultBySource: Record<string, boolean> = {}
    for (const src of listsSources) enabledByDefaultBySource[src.source] = !!src.enabledByDefault
    const byAddress = enabledTokensByAddressForChain(listsStatesByChain[chainId], chainId, enabledByDefaultBySource)
    return tokenBySymbolMap(byAddress, NATIVE_CURRENCIES[chainId], WRAPPED_NATIVE_CURRENCIES[chainId])
  }, [listsStatesByChain, listsSources, chainId])
}

/**
 * Resolve a single `{symbol, chainId}` to its canonical TokenWithLogo (or null),
 * including the chain's native and wrapped-native currency. Unlike
 * useTokenBySymbolOrAddress this resolves for a chain OTHER than the active one
 * (it never short-circuits on a network mismatch), which the intent flow needs
 * to rewrite a recognised symbol to an on-chain address for the URL's target
 * chain.
 */
export function useTokenForChainBySymbol(
  symbol: string | null | undefined,
  chainId: SupportedChainId | undefined,
): TokenWithLogo | null {
  const bySymbol = useTokenForChainMapBySymbol(chainId)

  return useMemo(() => {
    if (!symbol) return null
    return bySymbol[symbol.toLowerCase()] ?? null
  }, [bySymbol, symbol])
}
