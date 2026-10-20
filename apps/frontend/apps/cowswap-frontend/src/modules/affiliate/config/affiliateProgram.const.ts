export const AFFILIATE_TRADER_SAVED_CODES_STORAGE_KEY = 'cowswap:affiliateTraderSavedCodes:v0'
export const AFFILIATE_PENDING_REF_CODE_STORAGE_KEY = 'ophis:affiliatePendingRefCode:v0'
// The connected wallet's OWN referral code, cached so the post-trade share can
// embed it as ?ref= without a fresh signature. See affiliateOwnCodeAtom.
export const AFFILIATE_OWN_CODE_STORAGE_KEY = 'ophis:affiliateOwnCode:v0'

// ── On-chain partner attribution ─────────────────────────────────────────────
// Partner ref codes (kind='partner' in the rebate-indexer `ref_codes` table) whose
// ?ref-captured code is ALSO embedded in the order's on-chain appData
// (`metadata.ophisReferrer.code`) — so the rebate indexer credits them per-trade FROM
// CHAIN (recovered by backfill, survives an indexer outage) instead of only via the
// DB-side, net-new-gated `/ref/bind` wallet binding.
//
// Semantics vs. the /ref/bind arm (deliberate — brainstorming 2026-07-24):
//   • The on-chain arm is NOT net-new-gated. A distribution partner (e.g. Mt Pelerin's
//     in-app WebView) originates 100% of its flow, so ALL of its swaps are credited, not
//     just brand-new wallets — matching how SDK/widget partners already attribute on-chain.
//   • Affiliate codes are intentionally ABSENT here → they stay on the net-new-gated
//     /ref/bind arm only (that gate is the anti-farming control for SHARED affiliate links,
//     which does not apply to a captive partner surface).
//
// STATIC by design: the whole point is to survive a rebate-indexer outage, so membership
// must NOT depend on a live /ref/:code lookup. Codes are canonical lowercase end-to-end.
// Keep in sync with partner onboarding (POST /admin/ref-codes with kind='partner').
export const ON_CHAIN_PARTNER_REF_CODES: ReadonlySet<string> = new Set(['mtpelerin'])

// Timeout applied to referral service requests so UI fails fast on network issues.
export const AFFILIATE_API_TIMEOUT_MS = 10_000

// MUST mirror the backend code grammar (apps/rebate-indexer/src/api.ts).
export const REF_CODE_PATTERN = /^[A-Z0-9_-]{3,64}$/
