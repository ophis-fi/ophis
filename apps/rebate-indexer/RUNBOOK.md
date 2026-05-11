# Ophis Rebate Indexer — Runbook

Last-resort operator handbook. If a scenario isn't here, open an incident note and add it.

## How to reach the system
- SSH: `ssh root@ophis-rebates.aleph.cloud`
- Logs: `docker compose logs -f indexer`
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
4. Update Aleph VM env: `ssh root@ophis-rebates.aleph.cloud "sed -i 's/^SAFE_PROPOSER_PRIVATE_KEY=.*/SAFE_PROPOSER_PRIVATE_KEY=<new>/' /srv/rebate-indexer/.env && docker compose restart indexer"`.
5. In Safe → Settings → Transaction service → add the new proposer EOA.
6. Remove the compromised proposer from Safe → Settings → Transaction service.
7. The old key is now inert because Safe Transaction Service refuses its signatures.

## Routine ops

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
2. Update `TELEGRAM_BOT_TOKEN` in Aleph VM `.env`; `docker compose restart indexer`.

### Adding a new chain to the payout footprint (post-Phase-1)
Out of scope for v1. When ready, edit `src/safe/addresses.ts` `WETH_BY_CHAIN`, deploy the Safe MultiSendCallOnly on the new chain (CREATE2 via `@safe-global/safe-deployments`), and bridge WETH to that chain's Safe address.
