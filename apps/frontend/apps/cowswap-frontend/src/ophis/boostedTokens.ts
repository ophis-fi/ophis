import { SupportedChainId } from '@cowprotocol/cow-sdk'

/**
 * Boosted-token program: the generalizable lever behind the ALEPH flagship.
 *
 * A SAME-CHAIN swap where EITHER side is a boosted token pays the reduced
 * OPHIS_BOOSTED_VOLUME_BPS (the "max rebate" rate) instead of the standard volume
 * fee, REGARDLESS of the trader's volume tier. It flows through the same single
 * volumeFeeAtom source as the standard and stablecoin rates, so the quote display
 * and the on-chain appData fee stay in lockstep (no hidden or double charge).
 *
 * This is a partnership / business-development product: list a partner's token here
 * (with the swap-box badge) to incentivise trading it on Ophis. Adding a token is one
 * line per chain. Same-chain only, mirroring the stablecoin rule: a cross-chain bridge
 * leg's fee sits on the source token and boosting it is ambiguous, so we keep it safe.
 *
 * FLAGSHIP: ALEPH (Aleph Cloud). Ethereum mainnet is seeded below; add Base / other
 * chains once each per-chain ALEPH address is confirmed (one entry each).
 *
 * Addresses are stored LOWERCASE and matched against a lowercased currency address
 * (see isBoostedTradeAtom) so the match is case-insensitive and checksum-agnostic.
 */

/** Reduced "max rebate" rate for boosted-token trades, in bps (1 = 0.01%). */
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
