# Ophis Rebate Indexer — Runbook

Last-resort operator handbook. If a scenario isn't here, open an incident note and add it.

## How to reach the system
- Host: Cadia. Deployment SSH listens only on Cadia's Tailscale address, port
  `2222`; it is not exposed on the public network.
- CI access: the `production` GitHub environment stores
  `CADIA_REBATES_SSH_HOST`, `CADIA_REBATES_SSH_USER`,
  `CADIA_REBATES_SSH_PORT`, `CADIA_REBATES_SSH_PRIVATE_KEY`, and the pinned
  `CADIA_REBATES_SSH_HOST_KEY`. The runner joins Tailscale as `tag:ci` before
  opening the key-authenticated SSH connection.
- Operator SSH: `ssh -p 2222 <CADIA_REBATES_SSH_USER>@<CADIA_REBATES_SSH_HOST>`
- Working directory: `/srv/ophis/apps/rebate-indexer`
- Logs: `docker compose logs -f indexer`
- Tunnel logs: `docker compose logs -f cloudflared`
- Health: `curl -fsS https://rebates.ophis.fi/health`
- Status: `curl -fsS https://rebates.ophis.fi/status`
- DB shell: `docker compose exec pg psql -U rebates`
- Safe queue: <https://app.safe.global/transactions/queue?safe=gno:0x858f0F5eE954846D47155F5203c04aF1819eCeF8>

## Incident scenarios

### 1. Public stats or leaderboard stale
**Detect:** `/health` returns `data_fresh=false`, `data_status=degraded`, or the
scheduled `Rebate public-data freshness` workflow alerts. `data_as_of` is the
last completed scorer publication; unlike `last_fetch`, it advances even during
a legitimate quiet period with no new trades.
1. Check the durable heartbeats:
   `curl -fsS https://rebates.ophis.fi/health | jq '{data_status,data_as_of,data_stale_reason,last_fetch_attempt,last_pipeline_run_at}'`.
2. Inspect `docker compose ps` and `docker compose logs --since=30h indexer`.
3. Restart container: `docker compose restart indexer`. Startup runs fetch,
   pricing, and scorer recovery without waiting for the 02:00 UTC tick.
4. Confirm `data_fresh=true`, then compare `/stats` and `/leaderboard` before and
   after recovery. Record trade, trader, volume, and per-chain deltas.

### 2. Fetcher running but trades may be missing
**Detect:** `/health` is fresh but a user reports a missing trade, or the
independent scanner disagrees with the indexed totals.
1. Run all-chain reconciliation from the repo machine:
   `pnpm --dir apps/rebate-indexer scan --since 7d`. Use
   `SCAN_RPC_<CHAIN>` to override a degraded public RPC.
2. Require every chain's coverage status to be `ok`; a degraded chain is an
   incomplete audit, not evidence of zero missing trades.
3. Inspect unresolved settlement fills and compare order UIDs with `trades`.
4. Restart the indexer for an owner/API backfill, then rerun the same scanner
   window and retain both JSON artifacts as incident evidence.

### 3. DefiLlama endpoint stays at 503
**Detect:** `/defillama?date=YYYY-MM-DD` returns `DefiLlama settlement history
backfill in progress` after the main stats recovery.
1. Inspect the owner queue and every production-fill completeness gate:
   `SELECT count(*) FROM defillama_backfill_wallets;` and
   `SELECT chain_id,count(*) FROM defillama_fills WHERE chain_id IN (1,10,56,100,130,137,4663,8453,9745,42161,43114,57073,59144) AND (NOT fee_verified OR assessed_fee_bps IS NULL OR value_usd IS NULL OR transaction_hash IS NULL OR user_address IS NULL) GROUP BY chain_id;`.
2. Inspect aggregate-to-fill audit gaps:
   `SELECT t.chain_id,count(*) FROM trades t WHERE t.chain_id IN (1,10,56,100,130,137,4663,8453,9745,42161,43114,57073,59144) AND t.fee_verified AND (t.defillama_expected_fill_count IS NULL OR t.defillama_expected_fill_count <> (SELECT count(*) FROM defillama_fills f WHERE f.chain_id=t.chain_id AND f.trade_uid=t.trade_uid)) GROUP BY t.chain_id;`.
3. Check the matching exact-UID orderbook, settlement RPC, attribution, assessment,
   or pricing error in indexer logs.
4. Fix the chain-specific RPC/orderbook/price namespace issue. Do not manually
   set `defillama_reporting_state.completed_at`; the endpoint is intentionally
   fail-closed until every gate drains.
5. Restart for a retry and confirm both queries return zero rows before testing
   the endpoint again.

### 4. Pricer behind (high `value_usd IS NULL` count)
**Detect:** Wallet volumes in `/tier/:wallet` look low; users report missing rebates.
1. Inspect: `docker compose exec pg psql -U rebates -c "SELECT COUNT(*) FROM trades WHERE value_usd IS NULL;"`.
2. Backfill: `docker compose exec indexer pnpm cli replay-pricer --since=2026-05-01`.
3. The `wallets` materialized view auto-excludes unpriced trades, so once pricing catches up, tiers self-correct on next nightly refresh.

### 5. Batch never mined
**Detect:** `rebate_batches.status = 'proposed'` for >24h on the 1st of the month.
1. Open Safe queue; check whether the tx is signed but not executed (gas spike, nonce conflict).
2. If signed-and-stuck: re-execute from Safe UI with higher gas.
3. The indexer's `waitForExecution` poller auto-detects success once mined; no manual DB update needed.

### 6. Wrong tier paid out
**Detect:** User reports a discrepancy; you confirm via `/batches/:id`.
1. Batch is final on-chain — no recall.
2. Compute the delta: `docker compose exec indexer pnpm cli diff-rebate --batch-id=N`.
3. Manually queue a corrective WETH transfer via Safe UI.
4. Open an incident note in `docs/development/incidents/YYYY-MM-DD-tier-correction.md` describing the cause + fix.

### 7. Proposer key compromised
**Detect:** Junk batches appearing in Safe queue; logs show proposals you didn't make.
1. Don't panic — the proposer key has NO execution authority.
2. **Reject all suspicious proposals in Safe UI** (does not cost gas; the queue entry stays as a record).
3. Generate a new proposer:
   ```bash
   cast wallet new                                   # save PK in macOS Keychain `ophis-rebate-proposer`
   ```
4. Update Cadia's protected `.env` at
   `/srv/ophis/apps/rebate-indexer/.env`, then run
   `docker compose restart indexer`. Never put the key on a command line or in
   shell history.
5. In Safe → Settings → Transaction service → add the new proposer EOA.
6. Remove the compromised proposer from Safe → Settings → Transaction service.
7. The old key is now inert because Safe Transaction Service refuses its signatures.

## Routine ops

### Finite trade-reward campaign

The campaign creates one winning ticket per eligible wallet for a verified, settled Ophis swap of
at least $100 made after the campaign row's immutable `created_at`. Same-token swaps are excluded.
Wallet age and wallet balance are not checked.

Before enabling the rewards Compose override, review qualifying-wallet clusters and record any
evident self-dealing or manufactured volume in `trade_reward_wallet_blocks`. Every block requires a
plain-language reason, evidence reference, and operator identity. Never block a wallet solely because
it is new or has a low balance.

```sql
INSERT INTO trade_reward_wallet_blocks (wallet, reason, evidence, created_by)
VALUES (decode('<address-without-0x>', 'hex'), '<reason>', '<incident/query reference>', '<operator>');
```

Keep `TRADE_REWARDS_ENABLED=false` until that review is complete. The database and contract enforce
one ticket per wallet and stop allocation after ticket 105. Do not alter the allocation seed after
the campaign commitment has been stored.

### Fee-treasury sweeps feed the payout pool (documentation reference)
OP-chain CIP-75 fees accrue in the Settlement contract and reach the fee
Safe only via the fee-treasury sweep (OphisFeeLiquidator; runner
`infra/optimism-mainnet/scripts/sweep-to-safe.sh`). A sweep must precede
each monthly batch cycle or the pool understates realized revenue. The
planned `fee_sweeps` reconciliation table (Swept-event ingestion, buffer
probe, `GET /fees/ops`) is a separate indexer PR; until it lands, realized
revenue = the liquidator's `Swept` event log. Full procedure, ceremonies,
and rollback: `docs/operations/fee-treasury-ops-runbook.md`.

### Monthly batch — pre-execute ritual
On the 1st of each month at ~02:30 UTC you'll get a `💸 Batch ready to sign` Telegram message.

1. Open the Tenderly fork simulation link the message includes (or run `pnpm cli simulate-batch` if missing):
   ```bash
   docker compose exec indexer pnpm cli simulate-batch --fork-rpc=$TENDERLY_FORK_URL
   ```
2. Confirm: pool size, recipient count, top recipient, Σ shares ≤ pool.
3. Open the Safe queue link. Verify the same MultiSend payload is what's queued.
4. Sign + execute.
5. Wait for `🟢 Batch executed` Telegram confirmation (within 1 minute of mine).

### Rotating the Telegram bot token
1. Talk to BotFather → `/revoke` → `/newbot`.
2. Update `TELEGRAM_BOT_TOKEN` in Cadia's `.env`; `docker compose restart indexer`.

### Cloudflare tunnel disconnected (`530` / error `1033`)
The existing `ophis-rebates` tunnel runs as the `cloudflared` Compose service
and routes its single hostname to Caddy on `127.0.0.1:80`.

1. Confirm the origin: `curl -fsS http://127.0.0.1/health`.
2. Inspect the replica: `docker compose ps cloudflared` and
   `docker compose logs --tail=100 cloudflared`.
3. Confirm public ingress: `curl -fsS https://rebates.ophis.fi/health`.
4. If the token was rotated, write the new `TUNNEL_TOKEN` only to Cadia's
   mode-0600 `.env`, then run `docker compose up -d cloudflared`.
5. Do not create a replacement tunnel or DNS record during an incident; the
   persistent tunnel ID and hostname route remain the production identity.

### Handing reward claims to a partner (Octav)

Partner-fulfilled perks (currently `octav-20`) are issued by the PARTNER, not by
Ophis, so the partner needs the list of who claimed. Claims land in
`reward_claims` via `POST /rewards/claim`: signature-gated, XP re-checked
server-side, one row per (wallet, reward).

Export the list (admin token, from Cadia or over the tunnel):

```bash
curl -fsS -H "Authorization: Bearer $REBATE_INDEXER_ADMIN_TOKEN" \
  'https://rebates.ophis.fi/rewards/claims?reward=octav-20&format=csv' \
  -o octav-claims.csv
```

For a follow-up hand-off, send only what is new since the last one. `since`
filters on `updated_at`, so it also catches a claimer who corrected their email:

```bash
curl -fsS -H "Authorization: Bearer $REBATE_INDEXER_ADMIN_TOKEN" \
  'https://rebates.ophis.fi/rewards/claims?reward=octav-20&format=csv&since=2026-08-01T00:00:00Z' \
  -o octav-claims-delta.csv
```

Columns: `wallet, reward_id, email, xp_at_claim, claimed_at, updated_at`. Send
the partner **only** the columns they need to issue codes (`wallet`, `email`);
`xp_at_claim` is the eligibility evidence Ophis keeps.

Handling rules. This file is a wallet↔email join, the one piece of directly
identifying data this system holds. Claimers are told the email is used only to
contact them about the reward they claimed, never for marketing or any other
commercial purpose; that promise binds what these exports may be used for:

- Never commit an export, never post it in a shared channel, and never attach it
  to a ticket. Send it to the partner contact over an agreed private channel and
  delete the local copy afterwards.
- `?format=json` exists for scripting; `format=csv` is what partners want. Both
  are `no-store` and admin-only.
- Never load an export into a mailing list, CRM, or any commercial outreach.
  The claim form promises the address is used only for this reward.
- Deletion requests: delete the row, then tell the partner.
  `DELETE FROM reward_claims WHERE wallet = decode('<addr-no-0x>','hex') AND reward_id = '<id>';`
- Adding a partner-fulfilled perk means adding it to BOTH catalogs:
  `src/rewards.ts` here (the authority for claims + thresholds) and
  `apps/frontend/.../pages/Rewards/rewards.const.ts` (what renders). A perk
  missing from this side cannot be claimed at all.

### Adding a new chain to the payout footprint (post-Phase-1)
Out of scope for v1. When ready, edit `src/safe/addresses.ts` `WETH_BY_CHAIN`, deploy the Safe MultiSendCallOnly on the new chain (CREATE2 via `@safe-global/safe-deployments`), and bridge WETH to that chain's Safe address.

## Partner fees (partner-fees Phase B) -- MONEY PATH

Self-serve integrators register a fee recipient (Phase A registry) and attach a
`metadata.partnerFee` Volume entry. Ophis collects it at settlement, keeps 20%,
and pays the partner 80% monthly in WETH from the same Gnosis Ophis Safe the
rebate + affiliate batchers use (decision 18). Two-reviewer gate (reopens audit
C3/F6).

### How the money moves
1. **Nightly fetch + price** (`runPartnerFeeFetch` + `runPartnerFeePricer`, in the
   02:00 UTC pipeline). Polls the restricted feed
   `GET /restricted/api/v1/partner_fees` (Phase A, PR #926) per chain from
   `PARTNER_FEE_FEED_URLS`, attributes each trade's collected `protocolFeeAmounts`
   to its non-Ophis partner recipients, and inserts `partner_fee_trades`. Prices
   each collected fee into `fee_usd`. Idempotent (cursor + `(trade_uid, recipient)`
   PK).
2. **Monthly accrual** (`accruePartnerFees`, 1st of month, runs FIRST -- before the
   rebate + affiliate batchers). Sums each partner's new priced fees, adds the
   carry, applies the 80% split + $25 minimum + sanctions screening, and records a
   `partner_fee_batches` row + `partner_fee_batch_entries` (paid / carried /
   quarantined), stamping the consumed trades so their fee is never counted twice.
   This establishes the **outstanding partner liability**.
3. **Monthly proposal** (`proposePartnerFeeBatches`, gated by
   `PARTNER_FEE_PAYOUT_ENABLED`, default OFF). Dry-runs the paid transfers
   (quarantining any that revert), guards the Safe balance net of queued
   proposals, and proposes one WETH MultiSend; execution needs the 2-of-3 human
   signature.

### MONEY-CORRECTNESS invariant (the double-spend guard)
Partner fees land in the SAME Safe as rebates + affiliate payouts. The
partner-owed 80% must never be paid twice. Enforced by:
- **Ordering:** partner accrual runs FIRST each cycle (cron), before the rebate +
  affiliate computation.
- **Fail-closed:** if partner accrual THROWS on the 1st, the rebate batcher AND the
  affiliate payout are SKIPPED that cycle (they share the Safe and must not be
  distributed against a stale/absent liability). Own-fee (a separate sovereign Safe)
  still runs. Fix accrual and re-trigger the pipeline.
- **Rebate:** the rebate works in the NON-PARTNER balance (Safe WETH minus the full
  `outstandingPartnerLiabilityWei()`). DIRECT mode tracks its basis in that same
  non-partner space, so OLD partner debt already baked into a prior basis is NOT
  withheld twice; only the liability ACCRUED SINCE the basis is withheld. (`src/batcher.ts`)
- **Affiliate:** `planAffiliatePayout` reserves the partner liability in its
  over-draw guard (its available-balance basis subtracts it).
- **Partner proposal:** reserves the already-queued rebate + affiliate proposals,
  the mirror image.
Regression-locked by `tests/partnerFees/batcherLiability.int.test.ts` (incl. the
20/100/20 => 80 non-double-withhold case), `tests/partnerFees/affiliateReservation.test.ts`,
and `tests/partnerFees/cronFailClosed.test.ts`.

`outstandingPartnerLiabilityWei()` is the UNION of two disjoint parts: (a) the
carried/quarantined ROLLUP (each recipient's latest entry when it is
carried/quarantined -- latest-only, because the running carry folds into the
newest entry), plus (b) EVERY still-earmarked PAID entry whose batch is not yet
executed (summed across ALL of them, NOT latest-only, so a recipient paid in a
proposed-but-unexecuted batch who re-earns next cycle keeps BOTH in-flight amounts
reserved). All three consumers reserve this same view: the rebate batcher and
affiliate over-draw guard reserve the full (a)+(b); the partner proposer reserves
the already-queued proposals plus its own (a) carried/quarantined, so a fresh paid
batch can never strand a carried obligation.

The liability is a WETH-wei `owed_wei` snapshot taken at each entry's cycle price;
for a carried entry that snapshot can drift a little from its eventual re-priced
payout (amounts are sub-$25), so treat it as a conservative reservation, not the
exact payout. The exact payout is always the current-price conversion at proposal.

### Operational precondition: fund the Safe to at least the total outstanding partner liability

The reservation math (`R + P + A <= B`) holds ONLY while the Ophis Safe's WETH
balance `B` is at least the total outstanding partner liability `P` plus whatever
the rebate/affiliate cycles pay. Keep the Safe funded to at least `P` (surface it
with `pnpm cli partner-fee-accrue`, which prints the current outstanding liability,
and the `check-settlement-buffer` ops probe). If the Safe is under-funded, the
partner proposer BLOCKS (leaves the batch `computed`, alerts, retries next run)
rather than queuing a payout it cannot cover -- and the hard backstop is the Safe
MultiSend's ATOMIC revert: a proposal that would over-draw simply reverts on
execution and moves no funds, so under-funding can never cause a partial or wrong
payout, only a deferral.

### Chain-config safety assumption (fail-closed)

The positional fee->partner attribution is money-safe ONLY on chains whose
autopilot `[fee-policies]` is empty (so the only protocol fees are the appData
`partnerFee` entries). `CONFIG_FEE_FREE_CHAINS` in `src/partnerFees/fetch.ts`
asserts this per chain and the poller REFUSES to poll any chain not listed
(fail-loud). Before adding a chain to `PARTNER_FEE_FEED_URLS`, verify its
autopilot `[fee-policies]` is empty and add it to `CONFIG_FEE_FREE_CHAINS`; a
config protocol fee would prepend a slot and could mis-attribute to a partner.

### Carry-over and threshold
A recipient whose owed is below `MIN_PARTNER_PAYOUT_USD` ($25) CARRIES: nothing is
paid, `carried_usd` rolls forward and is re-evaluated next cycle. A quarantined
recipient (sanctions/list screen re-checked at payout, or a dry-run transfer revert)
also carries so the amount is never lost and is re-attempted once cleared. `owed_usd`
= `0.8 * Σ(new fee_usd) + carried_usd(prev)`.

A batch whose Safe execution FAILS (reverts) moved NO funds (atomic MultiSend), so
its `paid` entries are converted BACK to `carried` (retry path) and re-attempted
next cycle instead of being stranded in a terminally-`failed` batch. The dry-run
(`BATCHER_PROPOSE_ENABLED=false`) runs the FULL plan -- re-screen, simulate,
quarantine, and the Safe over-draw check -- and skips ONLY the Safe submission, so an
operator dry-run validates exactly what a real run would do (no DB writes).

### Month-end cutoff
The monthly accrual consumes ONLY trades whose settlement `block_timestamp` is before
the start of the run's month (the end of the settled month), so a first-of-month
pre-drain trade (settled 00:00-02:00 on the 1st) is not stamped to the previous
month. The poller enriches `block_timestamp` from the chain (`PARTNER_FEE_RPC_URL_<id>`
/ `SETTLE_RPC_URL_<id>`); a trade with a not-yet-enriched (NULL) timestamp is HELD out
of accrual until enriched, so a trade is never attributed to the wrong month (its
total is never lost -- it accrues in a later cycle once timestamped).

### Attribution safety (why a partner might not be paid for a trade)
On Optimism the only protocol fees are the appData `partnerFee` entries (no
config fees), so the indexer maps `protocolFeeAmounts[i]` to the i-th kept entry
positionally. If a partnerFee entry was dropped at settlement (unregistered /
suspended recipient), the slot count no longer matches and the trade is SKIPPED
(fail-safe UNDER-count, surfaced via a `partner-fee-fetch` alert) rather than
mis-attributed. Investigate skips before flipping any registration on.

### Enabling the program
1. Set `PARTNER_FEE_FEED_URLS=10=https://rebates.ophis.fi/restricted/api/v1/partner_fees`
   (comma-separated `<chainId>=<url>` per Ophis-operated chain); optional
   `PARTNER_FEE_FEED_AUTH` for the WAF secret. Accrual + the liability reservation
   start working immediately (payout still gated).
2. Confirm the internal test partner order settles and shows up:
   `pnpm cli partner-fee-accrue` then `pnpm cli partner-fee-dry-run`.
3. Flip `PARTNER_FEE_PAYOUT_ENABLED=true` only after the dry-run looks right. The
   monthly proposal then queues a Safe MultiSend for the 2-of-3 signers.

### Sanctions / list screening
`PARTNER_FEE_SANCTIONS_LIST` = comma-separated all-lowercase 0x addresses to block
at payout (plus the built-in zero address). A malformed entry throws (fail-loud).
A screened recipient is quarantined (carried forward, re-attempted once removed
from the list).

### CLI
- `pnpm cli partner-fee-fetch` -- one-shot feed poll + price.
- `pnpm cli partner-fee-accrue` -- record the settled-month ledger + print the
  outstanding liability.
- `pnpm cli partner-fee-dry-run` -- accrue then dry-run the payout (no Safe tx).

### Realized-revenue reconciliation (fee_sweeps)
The fee-ops `fee_sweeps` reconciliation table (its PR #920) does NOT yet exist in
this repo -- the RUNBOOK's fee-treasury section already notes it is a separate
indexer PR. Partner-fee accrual therefore uses the restricted FEED as the accrual
source (the executed `order_execution.protocol_fee_amounts`), which is the
authoritative on-chain collected amount. When `fee_sweeps` lands, wire a
reconciliation check (Σ paid partner WETH + Ophis retained ≈ swept realized
revenue) as a follow-up; it is not required for correctness of the accrual.
