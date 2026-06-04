# Ophis — Optimism Mainnet Operator Runbook

This stack runs the Ophis Protocol deployment on **Optimism mainnet (chain 10)**. It serves user intents submitted via [ophis.fi](https://ophis.fi), runs a solver auction across multiple aggregators, and settles trades through the on-chain `GPv2Settlement` contract.

**If you're paged at 3am: jump to [Common Failures](#common-failures).**

---

## Architecture

```
                    ┌──────────────────────────────────────┐
   ophis.fi  ───→   │  orderbook (HTTP :8102)              │
                    │     receives signed intents          │
                    └────────────┬─────────────────────────┘
                                 │
                                 ↓ Postgres :5435
                    ┌──────────────────────────────────────┐
                    │  autopilot (worker)                  │
                    │   batches orders → solver-auction    │
                    └────────────┬─────────────────────────┘
                                 │
                                 ↓ HTTP per-solver
        ┌────────────────────────┼────────────────────────┐
        ↓                        ↓                        ↓
   ┌─────────┐              ┌─────────┐             ┌────────────┐
   │ baseline│              │   okx   │             │ kyberswap  │
   │  :9022  │              │  :9023  │             │   :9024    │
   │ (V2)    │              │ (V3+    │             │  (V3+      │
   │         │              │  V/C/B) │             │   V/C/B)   │
   └────┬────┘              └────┬────┘             └──────┬─────┘
        └────────────────────────┼────────────────────────┘
                                 │
                                 ↓ best quote wins
                    ┌──────────────────────────────────────┐
                    │  driver (HTTP :8103)                 │
                    │   signs settle() with submitter EOA  │
                    │   0x92B9bE5e...A1B1                  │
                    └────────────┬─────────────────────────┘
                                 │
                                 ↓ JSON-RPC
                    ┌──────────────────────────────────────┐
                    │  GPv2Settlement (on-chain)           │
                    │  0x310784c7FCE12d578dA6f53460777bAc9 │
                    │            718B859                   │
                    └──────────────────────────────────────┘

External dependencies:
  ├── OP_MAINNET_RPC      → optimism-rpc.publicnode.com (primary)
  ├── OKX OnchainOS API   → web3.okx.com/api/v6/dex/aggregator/
  └── KyberSwap API       → aggregator-api.kyberswap.com/optimism/api/v1/
```

**Protocol authority**: 2-of-3 Safe (v1.4.1) at `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`, hardware-backed signers (see `docs/operations/founder-bus-factor.md` §2.2). Holds `owner()` (proxy-upgrade admin) and `manager()` of `AllowListAuthentication`. Threshold and the three owners verified on-chain. No timelock: solver-allowlist changes and AllowList upgrades take effect immediately on 2-of-3 execution.

**Partner-fee recipient**: `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` (separate Safe). Receives CIP-75 priceImprovementBps:2500 maxVolumeBps:50. On Optimism this is a Safe v1.4.1 with threshold 2 and the same three owners as the protocol Safe (verified on-chain). On Gnosis and Ethereum the same address is deployed 2-of-2 (owners `0xBeC5B03f…0199` + `0x0494F503…284d1A`). See `docs/operations/founder-bus-factor.md` §2.3.

**Public reachability**: `https://optimism-mainnet.ophis.fi` → Cloudflare Tunnel `ophis-optimism-mainnet` (id `56a68415-b1d9-4808-8218-850ec066b40b`) → `127.0.0.1:8102` on the Mac mini. Tunnel runs persistently via launchd at `~/Library/LaunchAgents/com.ophis.cloudflared.op-mainnet.plist`. Config at `~/.cloudflared/config-ophis-op-mainnet.yml`.

---

## Quick reference

| Field | Value |
|---|---|
| Chain ID | `10` |
| Settlement | `0x310784c7FCE12d578dA6f53460777bAc9718B859` |
| AuthListAuth Proxy | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| AuthListAuth Impl (current) | `0x59eE2de83b559e5cC2Afb930F29abeA3dBB4cc9D` |
| AuthListAuth Impl (initial, pre-upgrade) | `0xFAB54856B6731BC0C32904BE5297A627d9FDFA31` |
| VaultRelayer | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` |
| Balances | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` |
| Signatures | `0x5f315A204E7971fC29a66fef3a5773f6B0202fac` |
| HooksTrampoline | `0x2FbB1e41fF4f9b707E4428EEC7F5AFAaC5D60810` |
| Protocol Safe | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` |
| Partner-fee Safe | `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` |
| Driver-submitter EOA | `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1` |
| HW deployer | `0xBeC5B03ffDcac50071693E87bFDb88bAa6710199` |

> **AllowList impl upgrade.** The proxy was deployed with initial impl `0xFAB54856…` and later upgraded (via the Safe calling `upgradeTo`) to the two-step-manager impl `0x59eE2de8…` (`proposeManager`/`acceptManagership`/`pendingManager`). The current impl's `deployedBytecode` is verified byte-for-byte against the live `EXTCODEHASH`. Full record: [`contracts/deployments/optimism-mainnet/NOTE-allowlist-upgrade.md`](../../contracts/deployments/optimism-mainnet/NOTE-allowlist-upgrade.md). `GPv2Settlement` and `VaultRelayer` are non-upgradeable (no proxy).

### Host ports (all 127.0.0.1-bound)

| Port | Service | Notes |
|---|---|---|
| 5435 | postgres | DB password in `.env`, random-generated |
| 8102 | orderbook | HTTP API for ophis.fi |
| 8103 | driver | HTTP API for solver protocol |
| 9022 | baseline solver | V2-shape AMMs (Sushi on OP) |
| 9023 | okx solver | OKX OnchainOS aggregator |
| 9024 | kyberswap solver | KyberSwap aggregator (after #87 lands) |

### Secrets — Keychain (`security find-generic-password -s <name> -a ophis -w`)

| Name | Purpose |
|---|---|
| `ophis-driver-submitter` | PK for 0x92B9…A1B1 (settles on-chain) |
| `okx-api-key` | OKX OnchainOS auth |
| `okx-secret-key` | OKX HMAC signing |
| `okx-project-id` | OKX project identifier |
| `okx-passphrase` | OKX additional auth factor |

---

## Bring-up sequence

From scratch, on the Aleph VM (or wherever this stack lives):

```bash
cd /path/to/greg/infra/optimism-mainnet

# 1. First-time setup: copy template and fill in secrets
cp .env.example .env
# Edit .env, populate from Keychain:
#   OPHIS_DRIVER_SUBMITTER_KEY=$(security find-generic-password -s ophis-driver-submitter -w)
#   OKX_*  from corresponding Keychain entries
#   POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

# 2. Bring up the stack via the wrapper. compose-up.sh renders the templated
#    TOMLs, runs the Tier-1.5 RAM-disk + RPC-bypass safety checks, stamps the
#    git version into the orderbook /api/v1/version, then starts everything.
./compose-up.sh
#
# Fallback (raw compose, only if you JUST ran ./render-configs.sh): the bare
# command below SKIPS the safety checks AND leaves /api/v1/version on the
# vergen sentinel, because OPHIS_GIT_DESCRIBE is exported only by compose-up.sh.
#   ./render-configs.sh && docker compose up -d --build

# 3. Wait for healthchecks to settle (~60s typical)
docker compose ps
# Look for: orderbook, driver, baseline, okx-solver all in "healthy" state

# 4. Smoke test
curl -s http://127.0.0.1:8102/api/v1/auction | jq '.id'
# Should return the current auction ID (non-zero integer)
```

### Bringing it down cleanly

```bash
docker compose down       # stops + removes containers, keeps postgres volume
docker compose down -v    # ALSO drops the DB volume — use only if you want a fresh start
```

### Restart after a config change

```bash
./render-configs.sh         # re-render if you changed any .tmpl
docker compose up -d        # picks up TOML changes via volume mount; no rebuild needed
```

If you changed a Rust binary in `apps/backend/`, you need `--build`:

```bash
docker compose up -d --build
```

---

## Common failures

### `driver` keeps restarting with "private key must be set"

**Cause**: `.env` file is missing `OPHIS_DRIVER_SUBMITTER_KEY` (it's the `${VAR:?...}` guard in docker-compose.yml).

**Fix**:
```bash
echo "OPHIS_DRIVER_SUBMITTER_KEY=$(security find-generic-password -s ophis-driver-submitter -w)" >> .env
docker compose up -d driver
```

### `okx-solver` exits immediately

**Cause**: Either `rendered/okx.toml` doesn't exist (forgot to run `render-configs.sh`), or one of the OKX env vars is empty (typo in `.env`).

**Fix**:
```bash
ls -l rendered/okx.toml          # should exist
grep '"\$' rendered/okx.toml     # should be empty — any $VAR survivors mean .env is missing that var
./render-configs.sh
docker compose up -d okx-solver
```

### Driver logs show `RpcError: insufficient funds for gas`

**Cause**: Driver-submitter EOA at `0x92B9…A1B1` ran out of OP ETH. Settlements have been failing.

**Fix**: Bridge more ETH. The submitter needs ~0.005 ETH per ~50-100 settlements at current gas. Address: `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1`. Bridge via Across (~3min) or Hop. Top up to 0.05 ETH for ~weeks of runway.

```bash
cast balance --rpc-url https://optimism-rpc.publicnode.com 0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1 --ether
```

### Orderbook responds 503 / connection refused

**Likely cause**: Postgres unhealthy or migrations failed.

**Diagnose**:
```bash
docker compose ps              # which service is unhealthy?
docker compose logs db --tail 50
docker compose logs migrations
```

**Fixes**:
- DB volume corrupt → `docker compose down -v && docker compose up -d` (loses data)
- Migrations failed → rebuild migrations target: `docker compose up -d --build --force-recreate migrations`

### OKX solver returns no quotes for any pair

**Possible causes**:
1. Monthly free quota exhausted ($100 Basic + $50 Premium). Check the OKX dashboard.
2. API credentials expired or rotated upstream.
3. OKX rate-limiting (60-day trial RPS dropped to standard tier).

**Diagnose**:
```bash
docker compose logs okx-solver --tail 100 | grep -iE "401|403|429|quota"
```

**Fix paths**:
- Quota exhausted → wait until next month OR enable paid tier on OKX dashboard
- Auth failure → rotate keys via OKX dashboard, update Keychain, re-render, restart `okx-solver`
- Rate-limited → reduce `concurrent-requests` in the solver config (default: 5)

### Cloudflare Tunnel down — `optimism-mainnet.ophis.fi` returns 502 or hangs

**Diagnose**:
```bash
launchctl list | grep ophis.cloudflared.op-mainnet
# Expect: <pid> <exitcode> com.ophis.cloudflared.op-mainnet
# If pid is "-" or exitcode is non-zero, cloudflared has died.

tail -50 ~/Library/Logs/cloudflared-op-mainnet.err.log
```

**Fix**:
```bash
launchctl unload ~/Library/LaunchAgents/com.ophis.cloudflared.op-mainnet.plist
launchctl load -w ~/Library/LaunchAgents/com.ophis.cloudflared.op-mainnet.plist
sleep 10
curl -fs https://optimism-mainnet.ophis.fi/api/v1/auction | jq '.id'
```

If still failing, the backend orderbook may have stopped (`docker compose ps | grep orderbook`) or the tunnel credentials may have been invalidated upstream (regenerate via `cloudflared tunnel create`).

### Publicnode RPC starts returning 429 / 500s

**Cause**: Public free RPC degraded.

**Fast fix**: Swap to Nodies fallback. In `.env`:
```
OP_MAINNET_RPC=https://op-pokt.nodies.app
```
Then `docker compose up -d` (compose's env reloads the var into all services).

**Permanent fix**: Move to a paid RPC (Alchemy Growth $49/mo) if free options keep degrading.

### Driver logs show `eth_createAccessList: method not whitelisted`

**Cause**: Whoever is serving `OP_MAINNET_RPC` doesn't support `eth_createAccessList`. CoW driver needs it.

**Fix**: Swap RPC. publicnode and Nodies both support it. `https://mainnet.optimism.io` and `1rpc.io` do NOT.

### Driver gets 0 quotes per auction (all solvers return empty)

**Diagnose** in order:
1. Are the solvers healthy? `docker compose ps`
2. Is the orderbook generating auctions? `curl 127.0.0.1:8102/api/v1/auction | jq '.orders | length'`
3. Is the auction reaching the driver? `docker compose logs driver --tail 50 | grep -i "solving\|auction"`
4. Are individual solvers being called? `docker compose logs okx-solver --tail 100`
5. If solver was called but returned empty — what's the quote-side reason? Look for `OrderNotSupported` / `NotFound` / `RateLimited`.

---

## Secret rotation

90-day cadence recommended. Process:

### Postgres password

```bash
NEW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${NEW}|; s|@db:5432|@db:5432|" .env
# Update DB_WRITE_URL and DB_READ_URL too
docker compose down                   # MUST be down for DB to accept new password
docker exec -it postgres psql -U ophis -c "ALTER USER ophis PASSWORD '${NEW}';" || \
  docker compose down -v && docker compose up -d   # cold reset if password change fails
```

### Driver-submitter PK

This is the hardest rotation — the new EOA must be allowlisted on-chain via the protocol Safe. Procedure:

1. Generate new keypair: `cast wallet new` → save PK to Keychain as `ophis-driver-submitter`, note address
2. Fund new EOA with ~0.05 OP ETH
3. Via the protocol Safe (2-of-3), propose + execute: `AllowListAuthentication.addSolver(NEW_ADDR)`
4. Update autopilot.toml `[[drivers]] address = "NEW_ADDR"`
5. Update `.env` `OPHIS_DRIVER_SUBMITTER_KEY` = new PK
6. `docker compose up -d driver autopilot`
7. After 24h with no failed settlements: `AllowListAuthentication.removeSolver(OLD_ADDR)` via Safe
8. Sweep remaining ETH from OLD_ADDR back to a treasury wallet

### OKX credentials

1. OKX dashboard → generate new API key (revokes old after a grace period)
2. Update all 4 Keychain entries: `okx-api-key`, `okx-secret-key`, `okx-project-id`, `okx-passphrase`
3. Update `.env` from Keychain
4. `./render-configs.sh && docker compose up -d okx-solver`

---

## Monitoring

### Where logs live

```bash
docker compose logs --since 1h --tail 100 <service>
# Persistent: Docker logs are kept by default per `restart: always`; rotation
# is controlled by Docker daemon settings (default: ~10MB per container, no
# limit unless you set log-driver options).
```

For persistent monitoring, point a log shipper (Loki, Vector, Datadog) at `/var/lib/docker/containers/*/*-json.log`.

### Key metrics to watch (Prometheus, when wired)

- `driver_submission_success_total{network="op-mainnet"}` — settlements landed on-chain
- `driver_submission_revert_total` — solver picked a quote that reverted on chain (bad — investigate)
- `solver_quote_latency_seconds{solver="okx|baseline|kyberswap"}` — per-solver latency
- `solver_quote_total{solver=...,result="success|notfound|rate_limited|error"}` — quote outcomes
- `driver_submitter_balance_wei` — gauge on submitter EOA balance, alert below 0.005 ETH

Setting these up is its own workstream (not yet wired).

### Manual quick check

```bash
# Submitter balance
cast balance --rpc-url https://optimism-rpc.publicnode.com 0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1 --ether

# Latest auction
curl -s http://127.0.0.1:8102/api/v1/auction | jq '{id, orders: (.orders | length)}'

# Settlement count today (rough — via on-chain settlements)
cast logs --rpc-url https://optimism-rpc.publicnode.com \
  --from-block latest --to-block latest \
  --address 0x310784c7FCE12d578dA6f53460777bAc9718B859 \
  'Settlement(address)' 2>&1 | head -20
```

---

## Security rituals

Three-tier cadence; all three must run for full coverage.

### Per-PR (automated, GitHub Actions)

Set up in `.github/workflows/security.yml` (task #86). Runs on every PR to `docs/*` and `feat/*`:

- **Slither** on `contracts/src/contracts/` — block merge if new HIGH or MEDIUM findings vs the baseline (2026-05-13 audit)
- **pnpm audit --prod** across the workspace — block on HIGH or CRITICAL
- **cargo audit** on `apps/backend` — block on HIGH or CRITICAL

### Per-PR (manual, before merging significant changes)

For PRs touching Solidity, Rust solver code, deploy scripts, or the chain stack:

- **Codex second-opinion review** via `mcp__plugin_second-opinion_codex__codex`. Feed it the diff + the relevant module's existing code for comparison. Get severity-tagged findings, address before merging.

The KyberSwap branch (`feat/kyberswap-solver`) was reviewed this way — see `audit/kyberswap-review-2026-05-13.md`.

### Monthly (manual, full audit pass)

First Monday of each month:

- **Slither** full pass — diff the output against the previous month's audit. Any new findings = investigate.
- **pnpm audit --prod** + **cargo audit** — full advisories list, even non-HIGH
- **Trail of Bits `building-secure-contracts` checklist** — re-run if any contract changed
- Regenerate `audit/audit-report-YYYY-MM-DD.md` with the month's status + any new findings
- File issues for anything new, link to the audit report

### Verity formal verification

**N/A as long as we use unmodified CoW v2 forks.** The audit report (line 22) documents this. Re-evaluate only if we start authoring our own protocol Solidity.

### Echidna fuzz testing

**N/A on the CoW v2 forks** (CoW upstream already fuzz-tested those). Re-evaluate if we author or significantly modify contracts.

---

## Upgrade procedure when contracts need a patch

Worst-case scenario — a HIGH finding lands on a contract we deployed. Process:

1. **Triage**: is the vulnerability exploitable now? If yes, pause the stack (`docker compose stop driver autopilot`) to halt new settlements. Existing user funds at risk should be withdrawn — but note user balances live in their own wallets, not in Settlement. Only in-flight balances during a swap are at risk.

2. **Patch contracts**: fix in `contracts/src/contracts/`, write a test, get Codex + Slither + Echidna review. Time: hours to days.

3. **Deploy new versions**: use `deploy-mainnet-all.sh` again with the patched contracts. New contracts get NEW addresses. Time: ~10 minutes via Ledger ceremony.

4. **Migrate authority**: the protocol Safe transfers ownership of the NEW contracts to itself (Spec 5 mandate). HW wallet must be connected for the Ledger flow.

5. **Update infra**: change the contract addresses in `infra/optimism/.env`, `infra/optimism-mainnet/configs/{orderbook,autopilot,driver}.toml`. `./render-configs.sh && docker compose up -d`.

6. **Sunset old contracts**: optional — call `addSolver(0x0)` to brick the old AuthList, or simply leave it dormant. Document in `audit/` which address is current.

This procedure has been rehearsed with the testnet → mainnet migration on 2026-05-13. Process took ~3 hours including the audit + ceremony.

---

## Disaster recovery

### Aleph VM goes away

We don't have HA today. Recovery sequence:

1. Spin up a new VM (any IaaS — Aleph, Hetzner, AWS)
2. Install Docker + git clone the repo
3. Restore the `.env` file from backup (or regenerate Postgres password + redo signups for OKX/etc.)
4. Restore Keychain → secrets onto the new host
5. `./render-configs.sh && docker compose up -d`

DB volume can be lost without affecting protocol state — orders are signed off-chain and replayed from chain events on startup (or new orders just flow in).

### Driver-submitter PK compromised

If the PK leaked:

1. **Immediately**: via the protocol Safe, call `AuthList.removeSolver(0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1)`. This stops the compromised address from settling.
2. Withdraw remaining ETH from `0x92B9…A1B1` to a cold wallet.
3. Generate a new EOA, fund it, allowlist via Safe, update infra (see "Driver-submitter PK" under Secret Rotation).

Worst-case loss: trades that the attacker could have submitted as fake solver before we revoke. Bounded by:
- Auctions are batch-based; attacker must produce a valid solver solution to settle
- A malicious "solver" submitting bad settlements would just waste their own gas; they can't drain user funds because user signatures bound the trade
- They COULD frontrun legitimate solvers to extract MEV — bounded by available auctions per minute

### Settlement contract is exploited (worst case)

Out of scope for this runbook — would trigger the upgrade procedure above plus an incident response (post-mortem, user comms, audit re-run).

---

## Appendix: useful one-liners

```bash
# Full stack status
docker compose ps

# Force re-render and bounce one service
./render-configs.sh && docker compose up -d --force-recreate okx-solver

# Check what OP mainnet block we're at
cast block-number --rpc-url https://optimism-rpc.publicnode.com

# Get the current AuthList owner (should always be the Safe)
cast call --rpc-url https://optimism-rpc.publicnode.com \
  0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70 "owner()(address)"

# Confirm driver-submitter is still allowlisted
cast call --rpc-url https://optimism-rpc.publicnode.com \
  0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70 \
  "isSolver(address)(bool)" 0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1

# Most-recent settlement
cast logs --rpc-url https://optimism-rpc.publicnode.com \
  --address 0x310784c7FCE12d578dA6f53460777bAc9718B859 \
  "Settlement(address)" \
  --from-block latest 2>&1 | head -20
```

---

Last updated: 2026-06-04. Maintainer: Clement; repo `ophis-fi/ophis` (org owned by the `san-npm` account).
