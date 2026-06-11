# Ophis referral/affiliate system — implementation plan (prep 2026-06-09, build 2026-06-10)

Status: NOT built. This is the execution plan. Rates/economics locked in
`affiliate-program-model.md`; VIP roster in `vip-roster.private.md` (gitignored).

## Locked design (from affiliate-program-model.md)
- **Regular: 8% of NET fee, CAPPED at $1M referred volume/mo.** Public, self-serve.
- **Super VIP: 12% of NET fee, UNCAPPED.** Invite-only.
- Pay on the fee **Ophis KEEPS** (net): on CoW-hosted chains CoW takes 25% first
  (Ophis nets 7.5 bps of a 10 bps fee); on Optimism (sovereign) Ophis keeps the
  full 10 bps. Affiliate paid from Ophis's retained fees; the rebate pool is separate.
- Anti-fraud = **net-new wallets** + **pay on realized fees** (never volume bounty)
  + monthly batch window. Lifetime attribution.
- No new contracts. Reuse rebate-indexer rails + Safe payout.

## Grounding facts (verified in the rebate-indexer, 2026-06-09)
- `trades` table (`src/db/schema.ts:32`) ALREADY stores per settled trade:
  `tradeUid, chainId, wallet, sell/buyToken+Amount, appCode, partnerFeeWei,
  valueUsd, blockTimestamp`. This is the accrual substrate — no new indexing of
  fees needed; referral accrual is a JOIN over existing trade rows.
  - ⚠️ VERIFY tomorrow: is `partnerFeeWei` the GROSS appData fee or net of CoW's
    cut? If gross, apply `cowTake(chainId)` (0.25 hosted, 0 on OP=10) to get net.
    Check `src/fetcher.ts` ~line 90-116 where it's computed from the order.
- `tracked_wallets` registry: wallets enter via `GET /tier/:wallet`; the fetcher
  pulls each one's Ophis-tagged trades per chain. Referred wallets must be added
  here so their trades get indexed (bind endpoint should upsert into tracked_wallets).
- Batcher (`src/batcher.ts` + `batch/propose.ts` + `batch/multisend.ts`) already
  builds a monthly MultiSend → Safe payout. Affiliate payout reuses this exact path.
- API is Fastify (`src/api.ts`): `/tier/:wallet`, `/health`, `/status`, `/batches`.
  Add affiliate routes here. CORS already allows ophis.fi + *.pages.dev.
- Migration runner tracks files by NAME (`src/db/migrate.ts`) — add `0005_*.sql`.

## Attribution model (v1 = off-chain wallet-graph; recommended)
A referred wallet arrives via `?ref=CODE`, frontend records it, indexer binds
`referred_wallet -> referrer` IF the referred wallet is net-new (no prior Ophis
trade). Every subsequent trade by that wallet accrues `rate * netFee` to the
referrer. No appData change, no signing-path touch. (Alternative B: embed the
ref code in order appData for trustless on-chain attribution — heavier, defer to v2.)

## Schema additions (migration 0005)
- `ref_codes`: `code (pk), referrer_wallet, kind ('regular'|'vip'), created_at,
  active`. VIP codes seeded from the private roster; regular codes self-served.
- `referrals`: `referred_wallet (pk), code, referrer_wallet, bound_at,
  net_new (bool)`. One referrer per referred wallet, first-bind-wins, lifetime.
- `affiliate_payouts`: mirror of rebate batch tracking, scoped to affiliate —
  `id, cycle_month, referrer_wallet, owed_wei, paid_wei, status, safe_tx_hash`.
  (Or extend rebate_batch_entries with a `kind` column — decide tomorrow.)

## ⚠️ DATA REALITY (grounding 2026-06-10) — accrual is VOLUME-derived, not per-trade-fee
Two confirmed facts overturn the original "JOIN over partnerFeeWei" plan:
- `trades.partnerFeeWei` is **always NULL** (fetcher.ts:247 sets it null on every
  row). There is NO per-trade fee data in the indexer.
- The indexer indexes **only the 11 CoW-hosted chains** (cow/client.ts:8-20:
  mainnet, gnosis, base, arbitrum, polygon, avalanche, bnb, linea, plasma, ink,
  sepolia). **Optimism (chain 10) is NOT indexed** (it's the sovereign Ophis
  backend at optimism-mainnet.ophis.fi, not api.cow.fi).
What IS available per trade: `valueUsd` (volume, sell-side, clamped to $1M),
`wallet`, `appCode='ophis'`, `chainId`, `block_timestamp`. Plus the Safe WETH balance.
**Therefore affiliate accrual = referred VOLUME × affiliate-bps-of-volume**, which
EXACTLY matches the model doc's published rates (Regular 0.6 bps hosted / 0.8 OP;
Partner 0.9 hosted / 1.2 OP — i.e. fee-share% × gross-bps × keepFraction). v1 is
HOSTED-ONLY (OP not indexed → OP referred trades earn $0 until OP indexing ships).
Caveats to surface in-report + as Phase-2: (a) OP not counted; (b) stable-pair 1bp
trades use the standard 10bps rate (slight overestimate; indexer doesn't flag stable).

## Accrual logic (new `src/affiliate/computeAffiliate.ts`)
Per cycle (monthly): for each referrer, sum over their referred wallets' trades
in-window: `owed = Σ rate(code.kind) * netFee(trade)`. Apply the Regular $1M/mo
referred-VOLUME cap (sum referred valueUsd, clamp the accrual proportionally or
hard-stop past the cap — decide). VIP uncapped. Pay from Ophis's retained fees
(NOT the rebate pool); guard that affiliate + rebate payouts can't double-spend
the same WETH (they draw from different buckets — make the accounting explicit).

## API additions (`src/api.ts`)
- `POST /ref/bind` `{ referredWallet, code }` — bind if net-new + code active;
  upsert referred wallet into tracked_wallets. Rate-limited (reuse OPHIS_RATELIMIT).
- `GET /ref/:code` — resolve code -> exists/kind (for frontend validation).
- `GET /affiliate/:wallet` — referrer stats: referred count, volume, owed, paid.

## Frontend
DECISION (settle first tomorrow): (A) reuse the INHERITED CoW affiliate UI in
`apps/cowswap-frontend/src/modules/affiliate/` (full referral-code input + My
Rewards + Affiliate pages, already built; gated behind LaunchDarkly flag
`isAffiliateProgramEnabled`). Repoint its API client at the Ophis indexer and
flip the flag to a build-time Ophis env flag. Saves the UI build but inherits
CoW's BFF/CMS/Dune-shaped assumptions — audit its API contract vs our endpoints.
OR (B) build a lean Ophis-native `?ref=` capture (localStorage) + a single
`/affiliate` page. Leaner, no CoW-infra assumptions. Clement hates overengineering
→ lean toward (B) unless (A)'s UI maps cleanly.
Either way: `?ref=CODE` capture on load → localStorage → `POST /ref/bind` on first
wallet connect.

## Monthly settlement report (REQUIRED — Clement, 2026-06-10)
A full, accurate monthly accounting tying fees -> rebate + affiliate + retained.
First-class deliverable of this build, produced by the batcher's monthly cycle
(`src/affiliate/report.ts` + reuse `telegram/alerter.ts` for delivery).

Contents (one statement per calendar month; first cycle 7/1 covers 6/8->6/30):
1. **Volume & gross fees** — total traded volume USD (by chain), gross partner
   fees by token + USD. From `trades` (Σ valueUsd, Σ partnerFeeWei).
2. **CoW's cut** — 25% on hosted chains, 0 on Optimism. Net = gross - cut, per chain.
3. **Net fees that reached the Safe** — AUTHORITATIVE = on-chain WETH inflow to
   the fee Safe over the period (NOT the trades-table sum). Non-WETH fees flagged
   separately (#360; not in the WETH rebate pool).
4. **Rebate to traders** — 21.25% of net WETH fees; per-wallet table
   (wallet / tier / 30d-vol / amount); total. From computeShares.
5. **Affiliate to referrers** — per referrer (code / referred-vol / rate / payout);
   total. Paid from Ophis's retained share (NOT additional to the pool): a
   referred wallet's fee funds BOTH a slice of the general rebate pool AND the
   referrer's cut, both out of the same net fee.
6. **Ophis retained (to withdraw)** — `retained = net - rebate - affiliate`. The
   exact WETH amount Clement withdraws AFTER the payouts execute.
7. **Reconciliation** — assert `rebate + affiliate + retained == net` (dust-tol);
   compare trades-table-derived fees vs actual Safe inflow and FLAG any gap
   (coverage check, see caveat).

**ACCURACY CAVEAT (the thing that makes or breaks "accurate"):** the fetcher only
indexes trades for wallets in `tracked_wallets` (added when they hit `/tier`), so
the trades-table fee sum can UNDERCOUNT real fees. Ground truth for "fees earned"
must be the **Safe WETH inflow** (sum ERC20 Transfer events into the Safe over the
period), with the trades table used for the attribution breakdown and a flagged
reconciliation delta. Build the report on Safe inflow, not just trade rows.

**Flow (matches the withdrawal-after-payout rule):** report generated at cycle
start (1st) with PROPOSED rebate/affiliate/retained -> Clement reviews -> the
2-of-3 rebate + affiliate Safe payouts execute (already human-signed) -> Clement
withdraws the stated retained amount. Report is the show-before-submit gate.

Delivery DEFAULT (confirm): Telegram (Clement's preferred channel; alerter wired)
as a clean summary, PLUS a stored markdown/CSV per month for records. Decision:
Telegram-only vs Telegram+stored+/report endpoint.

## Rates config
Mirror the `tiers.ts` pattern: a single source-of-truth const
(`REGULAR_RATE_BPS=80`, `VIP_RATE_BPS=120`, `REGULAR_VOL_CAP_USD=1_000_000`)
+ `cowTake(chainId)`. If surfaced in SDK/frontend, add a check-invariant gate
like the tier one.

## Build sequence (tomorrow)
1. Confirm open decisions with Clement (below).
2. Verify `partnerFeeWei` gross-vs-net in fetcher.
3. Migration 0005 + schema + types.
4. `computeAffiliate.ts` + unit tests (testcontainer, mirror batcherDirect.test.ts).
5. API routes + rate-limit + tests.
6. Frontend capture + page (per decision A/B).
7. Payout wiring (reuse propose/multisend) + the double-spend guard + alerts.
8. **Monthly settlement report** (`src/affiliate/report.ts`): Safe-inflow-based
   fees + rebate + affiliate + retained + reconciliation; Telegram delivery via
   alerter; wire into the batcher cycle. Tests for the reconciliation math.
9. Codex + sharp-edges review (money path); seed VIP codes from private roster.
10. Public copy: docs/business "affiliate program" section once live.

## OPEN DECISIONS for Clement (confirm before building)
1. Frontend: reuse inherited CoW affiliate UI (A) or lean native (B)?
2. Payout Safe: same partner-fee Safe (0x858f…CeF8) or a separate affiliate Safe?
   (Affiliate is paid from Ophis's retained fees; same Safe means careful
   accounting vs the rebate pool to avoid double-spend.)
3. Attribution: off-chain wallet-graph v1 (recommended) or on-chain appData ref?
4. Regular cap behavior at $1M/mo: hard-stop accrual past the cap, or pro-rate?
5. VIP roster source: the gitignored vip-roster.private.md — confirm codes/wallets.
6. Monthly report delivery: Telegram-only vs Telegram + stored markdown/CSV +
   a `/report/:month` endpoint. (Default: Telegram summary + stored file.)
