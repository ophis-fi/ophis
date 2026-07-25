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

### 1. Fetcher stuck (no new trades for >24h)
**Detect:** `/status` shows stale `last_fetch`, or `🚨 fetcher failed 3 consecutive runs` Telegram alert.
1. Check CoW API health: `curl -sS https://api.cow.fi/xdai/api/v1/version | jq`.
2. Restart container: `docker compose restart indexer`.
3. Trigger a one-off run: `docker compose exec indexer pnpm cli replay-pricer --since=$(date -u -d '2 days ago' +%F)`.
4. CoW retains full trade history — no data is lost while we're stuck.

### 2. Pricer behind (high `value_usd IS NULL` count)
**Detect:** Wallet volumes in `/tier/:wallet` look low; users report missing rebates.
1. Inspect: `docker compose exec pg psql -U rebates -c "SELECT COUNT(*) FROM trades WHERE value_usd IS NULL;"`.
2. Backfill: `docker compose exec indexer pnpm cli replay-pricer --since=2026-05-01`.
3. The `wallets` materialized view auto-excludes unpriced trades, so once pricing catches up, tiers self-correct on next nightly refresh.

### 3. Batch never mined
**Detect:** `rebate_batches.status = 'proposed'` for >24h on the 1st of the month.
1. Open Safe queue; check whether the tx is signed but not executed (gas spike, nonce conflict).
2. If signed-and-stuck: re-execute from Safe UI with higher gas.
3. The indexer's `waitForExecution` poller auto-detects success once mined; no manual DB update needed.

### 4. Wrong tier paid out
**Detect:** User reports a discrepancy; you confirm via `/batches/:id`.
1. Batch is final on-chain — no recall.
2. Compute the delta: `docker compose exec indexer pnpm cli diff-rebate --batch-id=N`.
3. Manually queue a corrective WETH transfer via Safe UI.
4. Open an incident note in `docs/development/incidents/YYYY-MM-DD-tier-correction.md` describing the cause + fix.

### 5. Proposer key compromised
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
- **Rebate:** the DIRECT-mode distributable AND the POOL pool base SUBTRACT
  `outstandingPartnerLiabilityWei()` (`src/partnerFees/liability.ts`).
- **Affiliate:** `planAffiliatePayout` reserves the partner liability in its
  over-draw guard (its available-balance basis subtracts it).
- **Partner proposal:** reserves the already-queued rebate + affiliate proposals,
  the mirror image.
Regression-locked by `tests/partnerFees/batcherLiability.int.test.ts` and
`tests/partnerFees/affiliateReservation.test.ts`.

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
recipient (sanctions/list screen at payout, or a dry-run transfer revert) also
carries so the amount is never lost and is re-attempted once cleared. `owed_usd`
= `0.8 * Σ(new fee_usd) + carried_usd(prev)`.

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
