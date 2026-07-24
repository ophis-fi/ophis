import { ON_CHAIN_PARTNER_REF_CODES } from 'modules/affiliate/config/affiliateProgram.const'

/**
 * On-chain partner attribution tag for an order's appData.
 *
 * If `refCode` (the persisted `?ref=` code) belongs to a registered ON-CHAIN partner
 * (see `ON_CHAIN_PARTNER_REF_CODES`), returns the `{ code }` object to embed at
 * `metadata.ophisReferrer` — the field the rebate indexer reads to credit the partner
 * per-trade FROM CHAIN. That makes partner attribution survive a rebate-indexer outage
 * (recovered by backfill) and, unlike the DB-side `/ref/bind` arm, it is NOT net-new-gated:
 * a distribution partner originates 100% of its (e.g. in-app WebView) flow, so all of its
 * swaps are credited. This mirrors how SDK/widget partners already attribute on-chain.
 *
 * Returns `undefined` for affiliate / unknown / absent codes: those keep their DB-side,
 * net-new-gated `/ref/bind` attribution only and emit NO on-chain tag — preserving the
 * anti-farming gate that exists for shared affiliate links.
 *
 * Codes are canonical lowercase end-to-end (mirrors `RefCodeCaptureUpdater`'s
 * `savedCode.toLowerCase()` before signing/binding), so we normalize before the lookup —
 * otherwise the on-chain tag and the indexer's lowercase `ref_codes` lookup would miss.
 */
export function ophisReferrerForRefCode(refCode: string | undefined): { code: string } | undefined {
  if (!refCode) return undefined
  const code = refCode.trim().toLowerCase()
  return ON_CHAIN_PARTNER_REF_CODES.has(code) ? { code } : undefined
}
