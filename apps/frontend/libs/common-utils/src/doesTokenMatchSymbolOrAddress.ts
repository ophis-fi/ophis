import { Token } from '@cowprotocol/currency'
import { TokenInfo } from '@cowprotocol/types'

// 2026-05-17 hardening: `token` was typed as required, but several call
// sites pass `WRAPPED_NATIVE_CURRENCIES[chainId]` / `NATIVE_CURRENCIES[chainId]`
// which are undefined for chains outside SupportedChainId. Accept nullish
// and short-circuit to false — matching against nothing matches nothing.
export const doesTokenMatchSymbolOrAddress = (
  token: Token | TokenInfo | null | undefined,
  symbolOrAddress?: string,
): boolean => {
  if (!token) return false
  return (
    token.address?.toLowerCase() === symbolOrAddress?.toLowerCase() ||
    token.symbol?.toLowerCase() === symbolOrAddress?.toLowerCase()
  )
}
