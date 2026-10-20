import { SupportedChainId } from '@cowprotocol/cow-sdk'

/**
 * Token-specific base-fee configuration for same-chain swaps. Matching either
 * token selects OPHIS_BOOSTED_VOLUME_BPS through volumeFeeAtom so the quote
 * and appData use the same base fee. Improvement capture is applied separately.
 * Addresses are lowercase for case-insensitive matching.
 */

/** Base fee for configured tokens, in bps (1 = 0.01%). */
export const OPHIS_BOOSTED_VOLUME_BPS = 1

/** Per-chain set of boosted-token addresses (LOWERCASE). EITHER side triggers the boost. */
export const OPHIS_BOOSTED_TOKENS: Partial<Record<SupportedChainId, ReadonlySet<string>>> = {
  // ALEPH (Aleph Cloud) - Ethereum mainnet.
  [SupportedChainId.MAINNET]: new Set(['0x27702a26126e0b3702af63ee09ac4d1a084ef628']),
  // ALEPH (Aleph Cloud) - Base.
  [SupportedChainId.BASE]: new Set(['0xc0fbc4967259786c743361a5885ef49380473dcf']),
}

/** True if `address` (any case) is a boosted token on `chainId`. */
export function isBoostedToken(chainId: number, address: string | undefined): boolean {
  if (!address) return false
  return OPHIS_BOOSTED_TOKENS[chainId as SupportedChainId]?.has(address.toLowerCase()) ?? false
}
