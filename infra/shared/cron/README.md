# Safe + AllowList drift detection (weekly cron)

Monitors that the on-chain ownership of Ophis-controlled Safes + the
AllowList authentication manager hasn't drifted from expected.

## What it checks (per chain configured)

1. Protocol Safe `getOwners()` matches the expected sorted set.
2. Protocol Safe `getThreshold()` matches expected (default 2).
3. Partner-fee Safe `getOwners()` matches expected (default `[Clement Ledger #1]`).
4. AllowList authentication manager `manager()` == protocol Safe.
5. Configured submitter EOA `isSolver()` returns true.

Any drift → Telegram alert to chat `735726338`.

## Installation (one-time, on Mac mini)

```bash
# Render: drops the template into safe-drift-check.sh and chmod 700
# (it isn't templated yet — currently the .tmpl IS the runnable script.
#  Rename when secrets need substitution.)
cp infra/shared/cron/safe-drift-check.sh.tmpl infra/shared/cron/safe-drift-check.sh
chmod 700 infra/shared/cron/safe-drift-check.sh

# Update the EXPECTED_PROTOCOL_OWNERS_SORTED with the real 3 Ledger addresses
# (first owner already in place: 0x0494f503912c101bfd76b88e4f5d8a33de284d1a).
# Edit lines 30 + 33 of safe-drift-check.sh and fill in the 2 remaining Ledger
# addresses, then `git add` (NOT the rendered .sh — only the .tmpl) and commit.

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

Append a new stanza to `CHAINS=(...)` with fields:
```
name|chain_id|rpc_url|protocol_safe|partner_safe|allowlist_proxy|expected_submitter
```

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
