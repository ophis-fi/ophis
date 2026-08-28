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

---

# Container watchdog (`container-watchdog.sh`)

Restarts containers that have been **unhealthy** for a sustained period.

## Why

Docker does not restart an unhealthy container. `restart: always` fires on
process **exit**, not on a failing `HEALTHCHECK`. A container can therefore sit
`Up 46 hours (unhealthy)` indefinitely.

On 2026-08-23 the Robinhood driver did exactly that for eight hours. Its
healthcheck was correct and specific the entire time:

```
driver healthz reporting unhealthy
failures=["latest block was observed 331s ago, exceeds threshold 30s"]
```

Detection worked. Nothing consumed the signal. No quotes, no settlements, eight
hours. This script is the missing consumer.

## Why not an autoheal sidecar

The usual answer mounts `/var/run/docker.sock` into a third-party container.
Write access to that socket is root-equivalent on the host — it can launch a
privileged container that mounts `/`. These hosts hold settlement submitter
keys, so that is not an acceptable trade for a convenience feature. This runs on
the host from cron: no socket is exposed to any container, and no new image
enters the trust boundary.

## Safety properties (each pinned by `container-watchdog.test.sh`)

| Property | Behaviour |
|---|---|
| Allowlist only | Restarts only names matching `WATCHDOG_ALLOW`. Default: `driver\|orderbook\|rpc-proxy\|solver`. **`autopilot` is deliberately absent** — it declares no healthcheck in any stack, so it can never report unhealthy and this watchdog can never help it. Give it a healthcheck first, then add it here |
| Deny veto | `WATCHDOG_DENY` always wins — databases, chain nodes, observability. Protects against a later widened allowlist |
| Sustained only | Must be unhealthy for `WATCHDOG_THRESHOLD_S` (default 600s). Deploy flaps and slow starts do not trigger |
| Cooldown | At most one restart per container per `WATCHDOG_COOLDOWN_S` (default 1800s). A restart that does not fix the fault needs a human, not a loop |
| Recovery resets | A container reporting healthy clears its timer, so the next episode serves the full threshold |

**Never add a database or a chain node to the allowlist.** Restarting postgres
mid-write, or nitro (which then re-syncs for a long time), converts a
degradation into a worse outage.

### Health sidecars

`rpc-proxy` declares **no healthcheck** in any stack; only its `rpc-proxy-health`
sidecar does. An eRPC outage therefore surfaces as the *sidecar* going unhealthy.
Restarting the sidecar would bounce a BusyBox probe loop and leave the broken
proxy running, so `<name>-health-N` is mapped to `<name>-N` and the restart lands
on the proxy. The allow/deny decision is made on the **mapped target**, so a
sidecar cannot smuggle a denied container past the veto.

### Fail-closed behaviours

| Situation | Behaviour |
|---|---|
| `docker ps` fails (daemon down, no permission, not on PATH) | Logs FATAL, notifies, **exits nonzero**. Never reports a clean pass while blind |
| Cooldown state cannot be written | **Refuses to restart** and notifies. A restart that cannot be recorded becomes a restart loop on every cron tick |
| Another pass is already running | Exits without acting (flock). macOS has no `flock(1)`; there it warns that the pass is unserialised |
| The lock file cannot be **opened** | Logs FATAL, notifies, **exits nonzero**. Distinct from contention: a missing or unwritable `WATCHDOG_STATE_DIR` must not be mistaken for "another pass is running", which would silently disable the watchdog |
| Recovery state cannot be cleared | Refuses to restart **anything** for the rest of the pass and notifies. A stale timer left behind would shorten the next episode's threshold |
| Compose recreated the container | The stored container ID no longer matches, so the timer **re-arms**. A replacement that is merely still starting must not inherit its predecessor's accumulated unhealthy time |

## Install — Cadia / any Linux host

```bash
sudo install -m 0755 container-watchdog.sh /usr/local/bin/container-watchdog.sh

# The log directory MUST exist first. cron's shell opens the redirect BEFORE
# running the script, so without this the redirect fails, the script never
# executes, and it is the script that would have created the directory --
# leaving the watchdog permanently inactive with no obvious symptom.
mkdir -p ~/.local/state/ophis/watchdog

# Telegram credential. `security` is macOS-only, so on Linux point the watchdog
# at the token file the deploy already uses (see DEPLOY-RUNBOOK.md). Without
# this the watchdog still works but restarts happen SILENTLY.
# ⚠️ The token path is RELATIVE TO YOUR CHECKOUT. DEPLOY-WSL.md creates it with
# `mkdir -p secrets && ... > secrets/telegram-token` from inside
# infra/robinhood-mainnet/, so the absolute path is
#   <checkout>/infra/robinhood-mainnet/secrets/telegram-token
# Substitute your real checkout root below and CONFIRM the file is readable by
# the cron user before relying on it -- an unreadable token means every restart
# and every fatal failure happens silently.
OPHIS_CHECKOUT=/home/clement/ophis          # <-- verify this on the host
TOKEN="$OPHIS_CHECKOUT/infra/robinhood-mainnet/secrets/telegram-token"
test -r "$TOKEN" || echo "WARNING: $TOKEN not readable by $(whoami) — notifications will be silent"

( crontab -l 2>/dev/null; \
  echo "*/2 * * * * WATCHDOG_TG_TOKEN_FILE=$TOKEN /usr/local/bin/container-watchdog.sh >> ~/.local/state/ophis/watchdog/watchdog.log 2>&1" \
) | crontab -
```

Confirm it is actually running after installation -- a watchdog nobody verified
is the same as no watchdog:

```bash
sleep 150 && tail -3 ~/.local/state/ophis/watchdog/watchdog.log
# expect a "watchdog pass complete" line with a recent timestamp
```

## Install — Mac mini (launchd)

Use a `StartInterval` of 120 in a plist alongside the others in this directory.
Two environment traps, both of which have bitten this repo before:

1. **launchd sets no `$HOME`.** Set `WATCHDOG_STATE_DIR` explicitly, or the state
   file lands somewhere unintended.
2. **`docker` needs both PATH and its context.** launchd does not inherit a login
   shell, and on the Colima setup the active docker context lives under
   `$HOME/.docker`. With the wrong (or absent) `$HOME`, `docker ps` cannot reach
   the daemon at all. Verified while writing this: running with a scratch `$HOME`
   produces

   ```
   FATAL: cannot enumerate containers (docker ps exited 1): failed to connect
   to the docker API at unix:///var/run/docker.sock
   ```

   which is the fail-closed path doing its job — nonzero exit plus a Telegram,
   rather than a silent "0 restart(s)". Set `HOME` and `PATH` in the plist and
   confirm the log shows `watchdog pass complete` before trusting it.

## Verify before trusting it

```bash
WATCHDOG_DRY_RUN=1 ./container-watchdog.sh    # logs decisions, restarts nothing
./container-watchdog.test.sh                  # 17 cases, no daemon needed
```

CI runs the suite **and** deletes each safety property in turn to confirm the
suite goes red (`infra-shell-tests` in ci.yml). A watchdog that can restart a
database is worse than no watchdog, so "the tests pass" is not sufficient
evidence on its own — the mutations are what make it evidence.

## Known gap: tokens outside each probe's fixed list

The watcher only sees tokens each chain's probe queries, and those probes carry a
fixed address list. A fee accruing in any other token is invisible here, and the
"not covered" branch does not help: it only reports extra rows a probe already
emitted.

An earlier version of this note claimed the list only changes when we add a
market. **That is wrong on Robinhood Chain**, whose own solver config records that
`launch tokens are permissionless` (`infra/robinhood-mainnet/configs/pons.toml.tmpl`).
Surplus is denominated in the buy token for a sell order and the sell token for a
buy order, so a trade in any permissionlessly-listed token accrues fee value in a
token no probe covers, and every hourly run still reports clean.

Not closed here, and not by scanning all Transfer logs either - that needs archive
access the free RPC tiers refuse and turns a cron into an indexer. The bounded
version is the one to build when this matters: read the Settlement's own `Trade`
events over a recent block window, collect the sell/buy token addresses, and flag
any that the chain's probe does not query. Recent-window only, so no archive.

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `WATCHDOG_THRESHOLD_S` | 600 | Continuous unhealthy time before restart |
| `WATCHDOG_COOLDOWN_S` | 1800 | Minimum gap between restarts of one container |
| `WATCHDOG_ALLOW` / `WATCHDOG_DENY` | see above | Name regexes |
| `WATCHDOG_DRY_RUN` | 0 | `1` logs decisions without acting |
| `WATCHDOG_NOTIFY` | 1 | `0` disables Telegram (the test suite sets this) |
| `WATCHDOG_TG_TOKEN` | - | Bot token, highest precedence |
| `WATCHDOG_TG_TOKEN_FILE` | - | Path to a token file. **Required on Linux** -- `security` is macOS-only |
| `WATCHDOG_SKIP_LOCK` | 0 | `1` skips flock serialisation (tests only) |

---

# Sovereign settlement-buffer watch (hourly cron)

Measures the CIP-75 fee buffer inside the three sovereign Settlement contracts
and pages when a sweep would actually move something.

## Why

On Optimism, Unichain and Robinhood Chain the partner fee reduces the user's
executed buy amount but never transfers to the recipient Safe. It accrues inside
Settlement, and per `contracts/script/SweepSettlementBuffer.s.sol` an unswept
buffer is recycled into future traders' price improvement, which is functionally
zero Ophis revenue.

Each chain already had a `check-settlement-buffer.sh` probe. None of them was
ever scheduled, so the buffers went unmeasured from launch until the 2026-08-27
on-chain fee audit went looking and found $1.99 sitting across the three. This
job is the missing scheduling and alerting.

## What it alerts on

1. A token at or above its **sweep** threshold, meaning a sweep run now would
   actually move it. Deliberately not `> 0`: the sweep script skips
   sub-threshold tokens, so paging below it would report something no runbook
   can act on, hourly, forever. An alert that fires forever gets muted, and a
   muted alert is the same silence this job exists to end.
2. A token the chain's sweep configuration **does not cover** at all. An
   unrecognised token in the buffer is exactly how value goes unnoticed, so it
   surfaces as "not covered" rather than being skipped.
3. A probe that **failed, exited non-zero, emitted unparseable output, returned
   a report missing `probe_failures` or `balances`, measured zero tokens, or
   returned an INCOMPLETE report missing any of the symbols that chain is
   expected to measure**. Non-empty is not the same as complete: a probe
   returning only a healthy USDC row while WETH, native ETH and USDT vanish is
   still reported health that was never measured.
   An unreachable RPC is never read as an empty buffer, and syntactically valid
   JSON is not by itself a measurement: `{}` parses, and would otherwise sail
   through as a clean pass. A monitor reporting health it did not measure is
   worse than no monitor.

Thresholds are **per chain and per token**, mirroring each chain's own
`sweep-to-safe.sh` defaults, so this alarm and that action cannot drift apart:

| Chain | Covered by its sweep |
|---|---|
| optimism | USDC 1e7, WETH 3e15, native ETH 3e15 |
| unichain | WETH 1e15, USDC 1e7, native ETH 3e15 |
| robinhood | USDG 1e7, WETH 3e15, native ETH 3e15 |

Native ETH appears on every chain because the shared `SweepSettlementBuffer.s.sol`
sweeps the Settlement's native balance at `MIN_ETH_WEI` regardless of the TOKENS
list. Each probe also reports the chain id it read the balances from, and a report
naming the wrong network is rejected: the Settlement address in a report is a
static label, so a miswired proxy pointed at a fork would otherwise have its zero
balances accepted as a clean pass.

Matched on the token **address**, never the symbol. Robinhood Chain carries five
18-decimal USDG impersonators in the same Settlement contract as the real
6-decimal USDG, so symbol matching would apply the real token threshold to a
worthless one. The report is also checked to name the Settlement it was supposed
to measure: measuring something is not the same as measuring the right thing.

Per chain because they genuinely differ: unichain defaults WETH to 1e15 while
the other two use 3e15, so one shared table left a unichain balance between the
two sweepable by the stock script and invisible here. Per token because a single
wei threshold is decimals-blind: at 1e15 base units USDC (6 decimals) would need
$1B in the buffer before anyone was told, which is the HIGH-1 lesson from the
2026-05-22 audit re-applied.

An alert is only recorded as "seen" once Telegram delivery is **confirmed**. A
failed send is retried on the next run rather than muting a live condition for
24h on the strength of a page nobody received.

No price feed by design. Base-unit thresholds need no oracle, cannot go stale,
and cannot fail closed in a cron on a Mac mini.

## Installation (one-time, on Mac mini)

```bash
# The plist ships with the endpoints and repo path that actually work on the Mac
# mini. Check them before copying: OPHIS_REPO must be a checkout that HAS the
# scripts (not a stale feature branch), and the two per-chain RPCs exist because
# only OP's proxy is reachable from this host - :4002 and :4003 live on Cadia.
cp infra/shared/cron/ai.ophis.settlement-buffer-watch.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ophis.settlement-buffer-watch.plist
launchctl list | grep ai.ophis.settlement-buffer-watch
```

## Smoke test

```bash
launchctl kickstart -k gui/$(id -u)/ai.ophis.settlement-buffer-watch
sleep 10
tail -20 ~/Library/Logs/ophis-settlement-buffer-watch.log
```

Expected on a healthy pass: one `chain=<label> measured` line per chain, then
either `all sovereign buffers below their sweep thresholds; pass complete` or a
`pass complete (N finding(s))`. A run that ends without a `pass complete` line
crashed; treat that as an outage of the monitor, not as a clean result.

## Tests

```bash
bash infra/shared/cron/settlement-buffer-watch.test.sh
```

58 deterministic cases. No real RPC and no real Telegram (`BUFFER_NOTIFY=0`
everywhere except the delivery-failure case, which points the token file at a
path that does not exist and so fails before any network call), injected clock
for the 24h repeat window, and per-chain probes faked through `OPHIS_REPO`.
Every negative case asserts both that no alert fired and that the pass
completed, because a crash and a quiet pass are otherwise indistinguishable.

CI runs the suite and then ten mutations, each of which must turn it red
(`.github/workflows/ci.yml`, job `infra-shell-tests`). The mutation harness
guards itself too: a pattern that never matches, or one that produces an
unparseable script, is reported as a harness bug rather than counted as a pass.
Both of those fired while this was being written - a sed with an unescaped
delimiter inside a jq filter emptied the file, the suite failed, and it read as
"caught" while having tested nothing.

Note the job hardcodes its suites rather than globbing `*.test.sh`. A new suite
that is not listed there is a suite CI never runs.

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `BUFFER_REPEAT_S` | `86400` | Re-page interval for an unchanged condition. A newly-crossed chain always pages immediately, inside the window. |
| `BUFFER_NOTIFY` | `1` | Set `0` to log without sending Telegram. |
| `BUFFER_STATE_FILE` | pinned in the plist | Repeat-suppression state. Deleted on a clean pass so the next real finding pages at once. Pinned explicitly because launchd does not guarantee `HOME` and the script runs under `set -u`, so a `HOME`-derived default would abort on the assignment itself and leave the monitor installed, enabled and inert. |
| `OPHIS_REPO` | `/Users/scep/greg` | Where the per-chain probes are resolved from. Must be a checkout that actually has them. |
| `OPHIS_RPC_<CHAIN>` | probe default | Per-chain RPC, e.g. `OPHIS_RPC_ROBINHOOD`. Each probe defaults to a localhost proxy, but those proxies are not all on one host: the Mac mini reaches OP's on :4001 while the Unichain and Robinhood ones run on Cadia. Without an override there, the job pages hourly about two chains it cannot reach. |
