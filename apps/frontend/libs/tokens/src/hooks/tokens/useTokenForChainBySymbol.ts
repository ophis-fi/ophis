import { useMemo } from 'react'

import { getAddress } from '@ethersproject/address'

import { NATIVE_CURRENCIES, TokenWithLogo, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { useTokensByAddressMapForChain } from './useTokensByAddressMapForChain'
import { TokensByAddress } from '../../state/tokens/allTokensAtom'

/**
 * Build a `lowercaseSymbol -> TokenWithLogo` map from a by-address token map.
 *
 * The input is the priority-ordered by-address map from
 * useTokensByAddressMapForChain (its value-iteration order is priority order,
 * first writer wins per address), so iterating its values and taking the FIRST
 * token per symbol yields the canonical (highest-priority) token for that
 * symbol, mirroring how the swap form resolves an ambiguous symbol.
 *
 * `native` and `wrapped` are injected because useTokensByAddressMapForChain
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
  const byAddress = useTokensByAddressMapForChain(chainId)

  return useMemo(() => {
    if (!chainId) return {}
    return tokenBySymbolMap(byAddress, NATIVE_CURRENCIES[chainId], WRAPPED_NATIVE_CURRENCIES[chainId])
  }, [byAddress, chainId])
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
