# Safe + AllowList drift detection (weekly cron)

Monitors that the on-chain ownership of Ophis-controlled Safes + the
AllowList authentication manager hasn't drifted from expected.

## What it checks (per chain configured)

1. Protocol Safe `getOwners()` matches the expected sorted set.
2. Protocol Safe `getThreshold()` matches expected (default 2).
3. Partner-fee Safe `getOwners()` + `getThreshold()` match expected (2-of-3, same
   owner set as the protocol Safe since the 2026-06-05 unification).
4. AllowList authentication `manager()` == the expected manager (the
   AllowListGuardian since the #442 timelock migration; the protocol Safe before).
5. Configured submitter EOA `isSolver()` returns true.
6. AllowList proxy `owner()` == the expected proxy owner (the TimelockController
   post-#442; the protocol Safe before) — so `upgradeTo` stays 24h-delayed.
7. When a Guardian is the manager (post-#442): the Guardian's `guardian()` ==
   the protocol Safe (the instant-eviction authority) and its immutable
   `timelock()` / `authenticator()` match — so the manager isn't a rogue Guardian.
8. When a Timelock governs the chain (proxy owner != Safe): the Timelock's
   `getMinDelay()` >= 86400 (24h), and PROPOSER_ROLE + EXECUTOR_ROLE are each held
   by **exactly** the protocol Safe and TIMELOCK_ADMIN_ROLE by **exactly** the
   Timelock itself — enumerated via `getRoleMemberCount`/`getRoleMember`, so an
   extra/rogue role holder (a granted deployer/EOA) is caught, not just a missing one.

Any drift → Telegram alert to chat `735726338`.

## Installation (one-time, on Mac mini)

```bash
# Render: drops the template into safe-drift-check.sh and chmod 700
# (it isn't templated yet — currently the .tmpl IS the runnable script.
#  Rename when secrets need substitution.)
cp infra/shared/cron/safe-drift-check.sh.tmpl infra/shared/cron/safe-drift-check.sh
chmod 700 infra/shared/cron/safe-drift-check.sh

# EXPECTED_PROTOCOL_OWNERS_SORTED / EXPECTED_PARTNER_OWNERS_SORTED are now
# pre-filled with the live 3-owner set (0x0494f503…, 0x746ad9c6…, 0xbec5b03f…)
# and the OP CHAINS row carries the real allowlist_proxy + expected_manager
# (Guardian). Verify they still match on-chain before installing; update the
# .tmpl (NOT the rendered .sh) + commit if signers/manager ever change.

# Install launchd plist:
cp infra/shared/cron/ai.ophis.safe-drift-check.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ophis.safe-drift-check.plist

# Verify:
launchctl list | grep ai.ophis.safe-drift-check
```

## Triggering immediately for a smoke test

```bash
launchctl kickstart -k gui/$(id -u)/ai.ophis.safe-drift-check
sleep 5
tail -20 ~/Library/Logs/ophis-safe-drift-check.log
```

Expected first-run output:
- 1 line "checking chain=optimism (chain_id=10)"
- 1 line "chain=optimism passed all checks"
- Telegram silent (no drift)

If you see Telegram pings on first run: your `EXPECTED_PROTOCOL_OWNERS_SORTED`
hardcoded list doesn't match the real on-chain set. Fix the script's expectations.

## Adding a new chain

Append a new stanza to `CHAINS=(...)` with ALL nine fields (the preflight
exits if any is missing/non-address):
```
name|chain_id|rpc_url|protocol_safe|partner_safe|allowlist_proxy|expected_submitter|expected_manager|expected_proxy_owner
```
For a chain with NO timelock yet, set both `expected_manager` and
`expected_proxy_owner` to the protocol Safe (the manager/owner before migration);
the Timelock delay/role checks then auto-skip (they run only when proxy owner != Safe).

If the chain doesn't have the partner-fee Safe lazy-deployed yet, the script
will log a WARN and skip — no alert.

## Rotating signers

After a signer rotation:
1. Update `EXPECTED_PROTOCOL_OWNERS_SORTED` in the script
2. `git add infra/shared/cron/safe-drift-check.sh.tmpl && git commit`
3. Re-render and re-deploy (just copy the .tmpl → .sh; no plist change)

The script is intentionally noisy on owner drift — that's the whole point.
"Drift" should be either (a) a signer rotation you forgot to update the script for,
or (b) an actual unauthorized change.

## Files

- `safe-drift-check.sh.tmpl` — the script (chmod 755). Committed.
- `safe-drift-check.sh` — gitignored copy you run from. Created by hand from the template.
- `ai.ophis.safe-drift-check.plist` — launchd plist. Committed.
- `~/Library/Logs/ophis-safe-drift-check.log` — local log (created at first run).
- `~/Library/Logs/ophis-safe-drift-check.launchd.{out,err}` — launchd stdio capture.

## Coverage notes

Today (2026-05-19): only Optimism is monitored. To re-enable HL: add the
chain stanza. The HL contract addresses are the same CREATE2-deterministic
ones across chains (Safe + AllowList proxy).

## settlement-anomaly-watch (#444) — OP on-chain settlement monitoring

`../optimism-mainnet/scripts/settlement-anomaly-watch.sh`, scheduled by
`ai.ophis.settlement-anomaly-watch.plist` every 60s. READ-ONLY on-chain (only
`cast block-number/balance/logs/tx/abi-decode` against the OP eRPC) — no signing.
Cursor at `~/.local/state/ophis/settlement-watch/op-cursor`; log at
`~/Library/Logs/ophis-settlement-anomaly-watch.log`. Alerts reuse the
safe-drift Telegram path (token file + chat `735726338`).

Watched (GPv2Settlement `0x310784c7FCE12d578dA6f53460777bAc9718B859`; sole
authorized solver/submitter EOA `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1`):
- **(b) unexpected solver/target (CRITICAL):** every `Settlement(solver)` event's
  solver, and the settle() tx `from`/`to`, must be the submitter EOA / Settlement.
- **(c) submitter health (CRITICAL):** balance below `BALANCE_FLOOR_WEI` (0.005 ETH).
- **(a) surplus skim (WARNING):** `Trade` fee as bps of sell within the SAME token
  `> FEE_BPS_MAX` (500 = 5%). Oracle-free, so legitimate slippage can't false-trigger.

Env overrides: `OPHIS_RPC`, `BALANCE_FLOOR_WEI`, `FEE_BPS_MAX`, `MAX_BLOCKS`,
`STATE_DIR`, `TELEGRAM_BOT_TOKEN_FILE`, `TELEGRAM_CHAT_ID`.

Install: `cp ai.ophis.settlement-anomaly-watch.plist ~/Library/LaunchAgents/ &&
launchctl load ~/Library/LaunchAgents/ai.ophis.settlement-anomaly-watch.plist`.
Smoke-test (no Telegram, temp state): `STATE_DIR=/tmp/swtest
TELEGRAM_BOT_TOKEN_FILE=/tmp/none FIRST_RUN_LOOKBACK=2000
bash ../optimism-mainnet/scripts/settlement-anomaly-watch.sh`.
