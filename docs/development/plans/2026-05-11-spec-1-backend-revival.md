# Spec 1 — Backend revival + Linea cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revive the Phase 3 Ophis backend (Rust services for orderbook / autopilot / driver / baseline solver) by co-tenanting Optimism Sepolia and MegaETH testnet chain stacks onto the existing rebates VM, drop Linea (CoW serves it natively), and validate end-to-end with a real settled order on Optimism Sepolia.

**Architecture:** Two Docker Compose stacks (`infra/optimism/`, `infra/megaeth/`) sharing a single Aleph VM (`vm4.alephvision.eu` at `45.144.209.26:24014`) with the existing rebate-indexer. Each stack = 4 Rust services (orderbook + autopilot + driver + baseline) + Postgres, fronted by Caddy → cloudflared → public `<chain>-testnet.ophis.fi`. Reuses Phase 3's bytecode-verified testnet contracts at `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` (CREATE2-deterministic same address on every Ophis-target chain). No new contracts, no new wallets, no real ETH spent.

**Tech Stack:** Rust + Cargo (vendored `cowprotocol/services` subtree at `apps/backend/`), Postgres 16, Docker Compose, Caddy, Cloudflare Tunnel + DNS API, viem + cow-sdk for the smoke-test client, ssh + rsync for VM ops.

**Spec:** [`docs/development/specs/2026-05-11-spec-1-backend-revival.md`](../specs/2026-05-11-spec-1-backend-revival.md).

**Predecessor work:** Phase 3 testnet validation 2026-05-04 — same compose stacks ran successfully on the now-deceased VM at `149.86.227.106:24019`. Memory snapshot in `project_greg.md` § "Phase 3.5 — Aleph VM hosting".

**Phase gate:** `infra/optimism/scripts/smoke-test-e2e.sh` returns `✓ E2E passed, settlement tx 0x<hash>` against `optimism-sepolia.ophis.fi`, AND the tx is on-chain on Optimism Sepolia, AND the rebate-indexer at `rebates.ophis.fi/health` still returns `{ok: true}` after the revival is live.

---

## Operator decisions to lock BEFORE execution

| # | Decision | Default if undecided |
|---|---|---|
| **D1** | Smoke-test script language — Bash + cast + jq vs TypeScript + cow-sdk | **TypeScript + cow-sdk**. The cow-sdk signs orders the same way the cowswap frontend does, so the test exercises the real signing path. Bash + cast would shortcut some of the CoW-specific signing nuances. |
| **D2** | Memory limits per chain backend service in Docker — leave unset vs hard limit | **`mem_limit: 2g`** on `orderbook` and `driver`, `mem_limit: 1g` on `autopilot` and `baseline`, `mem_limit: 2g` on each `postgres`. Total ceiling: ~7.5 GB across the 2 chain stacks + 1.5 GB rebate-indexer = 9 GB of 16 GB. |
| **D3** | Cloudflared multi-tunnel topology — 2 separate systemd units vs 1 unified config | **2 separate systemd units** (`cloudflared-optimism-sepolia.service`, `cloudflared-megaeth-testnet.service`). Per-chain restart hygiene > config-file brevity. The existing rebate-indexer tunnel stays as its own unit. |
| **D4** | Backup Postgres volumes daily to S3 | **No backup in Spec 1**. Testnet order history is disposable; mainnet backup is a Spec 2/3 concern. |
| **D5** | Treat MegaETH testnet smoke-test sequencer-bug failure as success in CI | **Yes — the MegaETH testnet smoke test exits 0 if it reaches "driver simulated OK" log line + the known sequencer error, exits 1 only on other failures.** Avoids false-positives in CI. |

---

## File Structure (created or modified by this plan)

| Path | Action | Purpose |
|---|---|---|
| `infra/linea/` | **Delete** (`git rm -r`) | CoW Protocol serves Linea natively; our deployment was always validation-only. |
| `apps/backend/crates/chain/src/lib.rs` | Modify | Remove `LineaSepolia` enum variant + arms in `name()`, `default_amount_to_estimate_native_prices_with()`, `block_time_in_ms()`, `TryFrom<u64>`. |
| `apps/backend/crates/liquidity-sources/src/lib.rs` | Modify | Remove `Chain::LineaSepolia => vec![]` arm. |
| `apps/backend/crates/price-estimation/src/native/coingecko.rs` | Modify | Remove LineaSepolia from unsupported-chains bail. |
| `infra/megaeth/docker-compose.testnet.yml` | Modify | Remap orderbook port `8080→8082`, driver port `8081→8083`. Add `mem_limit` per D2. |
| `infra/optimism/docker-compose.testnet.yml` | Modify | Add `mem_limit` per D2. No port remap (already `8100/8101/9021/5434`). |
| `infra/optimism/scripts/smoke-test-e2e.ts` | Create | TypeScript end-to-end smoke test per D1; signs WETH→GTUSD order on Optimism Sepolia + verifies on-chain settlement. |
| `infra/megaeth/scripts/smoke-test-e2e.ts` | Create | Same shape as optimism test but with MegaETH testnet known-failure handling per D5. |
| `infra/optimism/scripts/package.json` | Create | npm package shell for the smoke-test scripts; deps cow-sdk + viem + chalk. |
| `infra/optimism/scripts/tsconfig.json` | Create | TS config for the smoke test. |
| `infra/cloudflare/ophis-chain-backends.md` | Create | Operator runbook: ssh path, per-container logs, single-chain restart procedure, third-chain template. |
| `docs/development/phase-3-validation.md` | Modify | Append annotation: Linea dropped (CoW native) + VM migrated to vm4.alephvision.eu co-tenancy on 2026-05-11. |
| `/etc/cloudflared/optimism-sepolia.yml` | Create on VM | cloudflared config for Optimism Sepolia tunnel. |
| `/etc/cloudflared/megaeth-testnet.yml` | Create on VM | cloudflared config for MegaETH testnet tunnel. |
| `/etc/systemd/system/cloudflared-optimism-sepolia.service` | Create on VM | systemd unit per D3. |
| `/etc/systemd/system/cloudflared-megaeth-testnet.service` | Create on VM | systemd unit per D3. |
| Memory file `project_greg.md` | Modify | Update § "Phase 3.5 — Aleph VM hosting" to reflect vm4 co-tenancy + Linea drop. |

**Not modified:** Anything in `apps/rebate-indexer/`, `apps/frontend/`, `packages/sdk/`, smart contracts on-chain. Spec 1 explicitly scoped to backend revival.

---

## Dispatch hints

- **Tasks 1-4** (Stage A): main session — git ops + Rust source edits, low risk.
- **Tasks 5-6** (Stages B-C): main session — long-running ssh + docker build (~15 min cold cargo build).
- **Tasks 7-9** (Stage D): main session — boot containers, watch logs.
- **Tasks 10-13** (Stage E): main session — Cloudflare tunnel + DNS API calls (already exercised on `rebates.ophis.fi` in this session, same pattern).
- **Tasks 14-16** (Stage F): `backend` agent — writes the TypeScript smoke-test script, executes it, captures the on-chain settlement tx hash as evidence.
- **Tasks 17-19** (Stage G): main session — runbook + memory update.

---

## Task 1: Drop `infra/linea/` from the tree

**Files:**
- Delete: `infra/linea/` (entire directory)

### Step 1: Verify the directory exists + inspect its size

```bash
cd /Users/scep/greg
ls infra/linea/ | head
du -sh infra/linea/
```

Expected: directory exists with `configs/`, `deploy/`, possibly `docker-compose.testnet.yml`, deploy logs.

### Step 2: Remove the directory from git tracking

```bash
cd /Users/scep/greg
git rm -r infra/linea/
git status --short | head
```

Expected: `git status` shows all `infra/linea/*` files prefixed with `D` (deleted, staged).

### Step 3: Commit

```bash
git commit -m "chore(infra): drop infra/linea/ — CoW Protocol serves Linea natively

The Linea Sepolia testnet validation was Phase 3 'proof we can deploy
to any chain' scaffolding. Now that CoW Protocol serves Linea via
api.cow.fi/linea natively (chainId 59144 in COW_SUPPORTED_CHAIN_IDS),
the Ophis-deployed Linea Sepolia stack is dead code with no production
path. Per Clement 2026-05-11."
```

---

## Task 2: Remove Linea variants from Rust source

**Files:**
- Modify: `apps/backend/crates/chain/src/lib.rs`
- Modify: `apps/backend/crates/liquidity-sources/src/lib.rs`
- Modify: `apps/backend/crates/price-estimation/src/native/coingecko.rs`

### Step 1: Find every reference to `LineaSepolia` in `apps/backend/`

```bash
cd /Users/scep/greg
grep -rn "LineaSepolia\|linea-sepolia\|Linea Sepolia" apps/backend/ | head -20
```

Expected: hits in the 3 files listed in "Files" above. May also surface deploy log files (`deploy-log-linea-sepolia-*.log`) — those are output artefacts, leave them.

### Step 2: Edit `apps/backend/crates/chain/src/lib.rs`

Open the file. Find the `Chain` enum:

```rust
pub enum Chain {
    Mainnet = 1,
    // ...
    LineaSepolia = 59141,    // <-- REMOVE this line
    // ...
}
```

Remove the `LineaSepolia` enum variant. Then find and remove the matching arms in:
- `impl Chain { fn name(&self) -> &str { match self { ... } } }`
- `impl Chain { fn default_amount_to_estimate_native_prices_with(...) }`
- `impl Chain { fn block_time_in_ms(...) }`
- `impl TryFrom<u64> for Chain { fn try_from(value: u64) -> Result<Self> { match value { ... } } }`

Any line containing `LineaSepolia` or the chain ID `59141` should be deleted.

### Step 3: Edit `apps/backend/crates/liquidity-sources/src/lib.rs`

Find the match expression:

```rust
match chain {
    Chain::MegaethTestnet | Chain::MegaethMainnet => vec![],
    Chain::OptimismSepolia => vec![],
    Chain::LineaSepolia => vec![],    // <-- REMOVE this line
    // ...
}
```

Remove the `Chain::LineaSepolia` arm.

### Step 4: Edit `apps/backend/crates/price-estimation/src/native/coingecko.rs`

Find the unsupported-network bail:

```rust
match chain {
    Chain::MegaethTestnet | Chain::MegaethMainnet => return Err(...),
    Chain::OptimismSepolia => return Err(...),
    Chain::LineaSepolia => return Err(...),    // <-- REMOVE this line
    _ => {}
}
```

Remove the `Chain::LineaSepolia` arm.

### Step 5: Verify the Rust workspace still compiles

```bash
cd /Users/scep/greg/apps/backend
cargo check --workspace 2>&1 | tail -20
```

Expected: `Finished ... in <Ns>` with no errors. Warnings about unused imports are acceptable; errors about `LineaSepolia` not found in some other file means there's a fourth match-arm to clean up (grep again).

### Step 6: Commit

```bash
cd /Users/scep/greg
git add apps/backend/crates/chain/src/lib.rs apps/backend/crates/liquidity-sources/src/lib.rs apps/backend/crates/price-estimation/src/native/coingecko.rs
git commit -m "chore(backend): drop LineaSepolia chain variant + match arms

Follows the infra/linea/ deletion. The Chain enum, the empty
baseline-liquidity-source arm, and the unsupported-coingecko-chain
arm all referenced LineaSepolia and are no longer needed."
```

---

## Task 3: Remap MegaETH compose ports + add memory limits

**Files:**
- Modify: `infra/megaeth/docker-compose.testnet.yml`
- Modify: `infra/optimism/docker-compose.testnet.yml`

### Step 1: Inspect current MegaETH port mapping

```bash
cd /Users/scep/greg
grep -nE "ports|mem_limit" infra/megaeth/docker-compose.testnet.yml | head -20
```

Expected: shows `8080:8080`, `8081:8081`, `9001:9001` exposed for orderbook/driver/baseline. No `mem_limit` lines yet.

### Step 2: Edit `infra/megaeth/docker-compose.testnet.yml`

Find the `orderbook` service. Change the ports mapping AND the `--bind-addr` arg if it appears in the `command:`:

```yaml
  orderbook:
    image: backend-orderbook:latest
    # ...
    ports:
      - "8082:8080"     # was "8080:8080"
    command:
      # if the command has --bind-addr 0.0.0.0:8080, leave it (internal port stays 8080)
    mem_limit: 2g
```

The container-internal port (`:8080` on the right side of the colon) does NOT change — only the host-side port. Update the `driver` service similarly:

```yaml
  driver:
    # ...
    ports:
      - "8083:8081"     # was "8081:8081"
    mem_limit: 2g
```

Add `mem_limit` to each of `autopilot`, `baseline`, `postgres`:

```yaml
  autopilot:
    # ...
    mem_limit: 1g
  baseline:
    # ...
    mem_limit: 1g
  postgres:
    # ...
    mem_limit: 2g
```

### Step 3: Edit `infra/optimism/docker-compose.testnet.yml`

Add the same `mem_limit` block to each of `orderbook`, `autopilot`, `driver`, `baseline`, `postgres`. Do NOT change port mappings (Optimism Sepolia already uses `8100/8101/9021/5434`, no conflict with the rebate-indexer on `8080`).

### Step 4: Validate the compose YAML

```bash
cd /Users/scep/greg/infra/megaeth
docker compose -f docker-compose.testnet.yml config > /dev/null
cd ../optimism
docker compose -f docker-compose.testnet.yml config > /dev/null
```

Expected: both commands exit 0 (silently). Any YAML syntax error prints to stderr.

### Step 5: Commit

```bash
cd /Users/scep/greg
git add infra/megaeth/docker-compose.testnet.yml infra/optimism/docker-compose.testnet.yml
git commit -m "chore(infra): remap megaeth ports off 8080/8081; mem_limits per service

The rebates VM (vm4.alephvision.eu) hosts the rebate-indexer on host
port 8080. Co-tenanting the megaeth-testnet stack requires moving its
host-side orderbook + driver bindings to 8082 and 8083 respectively.
Container-internal ports stay 8080/8081 — only the host bind changes.

Adds explicit mem_limit per service so a single chain stack can't OOM
the VM and take down the rebate-indexer co-tenant. Total ceiling ~7.5 GB
across 2 chain stacks of 16 GB available."
```

---

## Task 4: Annotate `phase-3-validation.md`

**Files:**
- Modify: `docs/development/phase-3-validation.md`

### Step 1: Read the existing doc top + bottom

```bash
cd /Users/scep/greg
head -40 docs/development/phase-3-validation.md
echo "---"
tail -10 docs/development/phase-3-validation.md
```

### Step 2: Append the migration annotation

Open `docs/development/phase-3-validation.md` and add a new section at the bottom:

```markdown

## Update — 2026-05-11 (Spec 1 backend revival)

Two changes since the original 2026-05-04 Phase 3 validation:

- **Linea Sepolia dropped.** CoW Protocol serves Linea mainnet natively
  via `api.cow.fi/linea` (chainId 59144 in `COW_SUPPORTED_CHAIN_IDS`). Our
  Linea Sepolia stack was always validation-only — the `infra/linea/`
  directory and the `LineaSepolia` Rust enum variant have been removed
  from the tree. Pools and contracts on Linea Sepolia are abandoned in
  place.

- **VM migration.** The Phase 3 hosting VM at `149.86.227.106:24019` is
  dead (TCP connection refused, instance presumed reclaimed by Aleph).
  Spec 1 revives the multi-chain backend by co-tenanting the
  optimism-sepolia and megaeth-testnet stacks onto the existing rebates
  VM at `vm4.alephvision.eu` (`45.144.209.26:24014`). Same SSH context as
  the rebate-indexer; chains exposed via per-chain named Cloudflare
  Tunnels (`optimism-sepolia.ophis.fi`, `megaeth-testnet.ophis.fi`)
  instead of the rotating `*.trycloudflare.com` quick-tunnels Phase 3 used.

- **Testnet contracts are unchanged.** CREATE2-deterministic deployment
  means Ophis's `GPv2Settlement` at `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce`
  still resolves on Optimism Sepolia and MegaETH testnet — verified
  via `cast code` 2026-05-11.

Spec doc: `docs/development/specs/2026-05-11-spec-1-backend-revival.md`.
```

### Step 3: Commit

```bash
cd /Users/scep/greg
git add docs/development/phase-3-validation.md
git commit -m "docs(phase-3): annotate validation log with Linea drop + VM migration"
```

---

## Task 5: Rsync the updated tree to the rebates VM

**Files:**
- VM-side: `/srv/ophis/apps/backend/`, `/srv/ophis/infra/optimism/`, `/srv/ophis/infra/megaeth/`

### Step 1: Verify SSH connectivity

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 'hostname && uptime'
```

Expected: hostname + uptime print. SSH key is the one we registered in the earlier rebates-VM session.

### Step 2: Rsync only the chain-backend bits + the apps/backend changes

```bash
cd /Users/scep/greg
rsync -avz -e "ssh -i ~/.ssh/aleph-greg -p 24014" \
  --exclude="target/" \
  --exclude="node_modules/" \
  --exclude=".env" \
  --exclude="docker-compose.*.yml.local" \
  apps/backend/ root@45.144.209.26:/srv/ophis/apps/backend/

rsync -avz -e "ssh -i ~/.ssh/aleph-greg -p 24014" \
  --exclude="deploy-log-*.log" \
  --exclude=".env" \
  infra/optimism/ root@45.144.209.26:/srv/ophis/infra/optimism/

rsync -avz -e "ssh -i ~/.ssh/aleph-greg -p 24014" \
  --exclude="deploy-log-*.log" \
  --exclude=".env" \
  infra/megaeth/ root@45.144.209.26:/srv/ophis/infra/megaeth/

# Also remove infra/linea/ on the VM if it was previously rsync'd
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 'rm -rf /srv/ophis/infra/linea/'
```

Expected: transfer summaries showing files synced; the linea/ deletion is silent.

### Step 3: Verify the VM has the expected layout

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'ls /srv/ophis/infra/ && echo "---" && ls /srv/ophis/apps/backend/crates/chain/src/'
```

Expected: `infra/` lists `optimism`, `megaeth`, `cloudflare`, `local`, `rpc` (not `linea`). `apps/backend/crates/chain/src/` shows `lib.rs`.

### Step 4: Spot-check the Rust source removal landed on the VM

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'grep -c LineaSepolia /srv/ophis/apps/backend/crates/chain/src/lib.rs'
```

Expected: `0` (no matches).

### Step 5: No commit in this task (VM-side state, not git-tracked).

---

## Task 6: Build the Rust services on the VM

**Files:**
- VM-side container images: `backend-orderbook:latest`, `backend-autopilot:latest`, `backend-driver:latest`, `backend-baseline:latest`, `backend-migrations:latest`

### Step 1: Check Docker is alive on the VM + warm the Cargo cache check

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'docker version | head -3 && docker images | grep -E "backend-|local-" | head'
```

Expected: Docker version prints. Image list may be empty (first revival) or show prior Phase 3 images (warm cache).

### Step 2: Build via the Optimism compose stack (this builds the shared backend image set)

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cd /srv/ophis/infra/optimism && docker compose -f docker-compose.testnet.yml build 2>&1 | tail -30'
```

Expected wall-clock: ~15-20 min cold cargo build. Layer cache makes the megaeth build in step 3 nearly instant.

Watch for:
- `Finished release [optimized]` for each crate (orderbook, autopilot, driver, baseline)
- `naming to docker.io/library/backend-orderbook` (or `local-orderbook`) at the end
- No `ERROR` lines

If build OOMs (rare on 16 GB but possible if rebates-indexer is mid-spike), fallback: add `RUSTC_NUM_JOBS=2` env to the Dockerfile build stage.

### Step 3: Build via the MegaETH compose stack (uses the warm cache)

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cd /srv/ophis/infra/megaeth && docker compose -f docker-compose.testnet.yml build 2>&1 | tail -10'
```

Expected: very fast (cached layers). Output ends with `naming to docker.io/library/backend-orderbook` (same image, MegaETH compose uses the same image tag).

### Step 4: Verify all expected images exist

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'docker images | grep -E "backend-(orderbook|autopilot|driver|baseline|migrations)|local-(orderbook|autopilot|driver|baseline|migrations)"'
```

Expected: 5 images listed (orderbook, autopilot, driver, baseline, migrations).

### Step 5: No commit (VM-side state).

---

## Task 7: Inject driver-submitter PK + chain RPCs into VM env

**Files:**
- Create on VM: `/srv/ophis/.env.shared` (mode 600)
- VM-side: appended to `/srv/ophis/infra/optimism/.env` and `/srv/ophis/infra/megaeth/.env`

### Step 1: Pull the driver-submitter PK from local Keychain + pipe into the VM (key value never appears in shell history or this output)

```bash
DRIVER_PK=$(security find-generic-password -l ophis-driver-submitter -w) ; \
  ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
    "umask 077 && cat > /srv/ophis/.env.shared <<EOF
DRIVER_SUBMITTER_PRIVATE_KEY=${DRIVER_PK}
OPTIMISM_SEPOLIA_RPC_URL=https://sepolia.optimism.io
MEGAETH_TESTNET_RPC_URL=https://carrot.megaeth.com/rpc
EOF
chmod 600 /srv/ophis/.env.shared
ls -la /srv/ophis/.env.shared" ; \
  unset DRIVER_PK
```

Expected: `-rw------- 1 root root <size> ... /srv/ophis/.env.shared`. The PK is now on the VM only; never echoed in this terminal.

### Step 2: Wire .env.shared into each chain's compose env

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'for chain in optimism megaeth ; do
    if ! grep -q "env_file:.*\.\./\.env.shared" /srv/ophis/infra/$chain/docker-compose.testnet.yml ; then
      echo "WARNING: $chain compose has no env_file ref to ../.env.shared"
      echo "Confirm it inherits env via env vars directly, or add env_file: at top-level x-env"
    fi
   done'
```

Expected: silent (no warnings) if the compose files already use `env_file:` or interpolate `${DRIVER_SUBMITTER_PRIVATE_KEY}` directly. If warnings print, the compose file uses bare env interpolation — pass `--env-file /srv/ophis/.env.shared` to `docker compose up` instead.

### Step 3: Verify the env file has the expected three keys (key values masked)

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'awk -F= "{print \$1\"=<set>\"}" /srv/ophis/.env.shared'
```

Expected output exactly:
```
DRIVER_SUBMITTER_PRIVATE_KEY=<set>
OPTIMISM_SEPOLIA_RPC_URL=<set>
MEGAETH_TESTNET_RPC_URL=<set>
```

### Step 4: No commit (VM-side state).

---

## Task 8: Boot the Optimism Sepolia stack

**Files:**
- VM-side containers: `optimism-orderbook`, `optimism-autopilot`, `optimism-driver`, `optimism-baseline`, `optimism-postgres`, `optimism-migrations` (one-shot)

### Step 1: Bring up the stack

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cd /srv/ophis/infra/optimism && \
   docker compose -f docker-compose.testnet.yml --env-file /srv/ophis/.env.shared up -d 2>&1 | tail -15'
```

Expected: `Creating optimism-postgres-1 ... done`, then migrations, then the four service containers each printed `Started`.

### Step 2: Wait for migrations to complete + verify service health

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cd /srv/ophis/infra/optimism && \
   for i in 1 2 3 4 5 6 7 8 9 10 ; do
     STATUS=$(docker compose -f docker-compose.testnet.yml ps --format json | jq -r ".State")
     if echo "$STATUS" | grep -qv "running\|exited"; then
       echo "[$i/10] still starting..."
       sleep 5
     else
       break
     fi
   done
   echo "---final status---"
   docker compose -f docker-compose.testnet.yml ps'
```

Expected: all 5 long-running services show `running (healthy)` or `running`; `optimism-migrations-1` shows `exited (0)`.

### Step 3: Test the orderbook locally on the VM

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'curl -fsS http://localhost:8100/api/v1/version | jq'
```

Expected: JSON with `version`, `commit`, `branch`. Anything HTTP-non-2xx means look at orderbook logs.

### Step 4: Capture orderbook logs for ~5 sec to spot any error spam

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'docker logs --tail 50 optimism-orderbook-1 2>&1 | head -30'
```

Expected: log lines like `listening on 0.0.0.0:8080`, `connected to postgres`, no `ERROR` repetition.

### Step 5: No commit (VM-side state).

---

## Task 9: Boot the MegaETH testnet stack

**Files:**
- VM-side containers: `megaeth-orderbook`, `megaeth-autopilot`, `megaeth-driver`, `megaeth-baseline`, `megaeth-postgres`, `megaeth-migrations`

### Step 1: Bring up the stack

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cd /srv/ophis/infra/megaeth && \
   docker compose -f docker-compose.testnet.yml --env-file /srv/ophis/.env.shared up -d 2>&1 | tail -15'
```

Expected: same shape as Task 8 Step 1.

### Step 2: Wait + health-check

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cd /srv/ophis/infra/megaeth && \
   sleep 15 && \
   docker compose -f docker-compose.testnet.yml ps'
```

Expected: all 5 long-running services running; megaeth-migrations exited 0.

### Step 3: Test the orderbook on remapped port 8082

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'curl -fsS http://localhost:8082/api/v1/version | jq'
```

Expected: JSON version response. If 502/connection refused, double-check Task 3's port remap landed on the VM (`grep -E "8082|8080" /srv/ophis/infra/megaeth/docker-compose.testnet.yml`).

### Step 4: Verify both stacks coexist + rebate-indexer is healthy

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'echo "=== rebates ===" && curl -fsS http://localhost:8080/health | jq && \
   echo "=== optimism ===" && curl -fsS http://localhost:8100/api/v1/version | jq -c "{version, commit}" && \
   echo "=== megaeth ===" && curl -fsS http://localhost:8082/api/v1/version | jq -c "{version, commit}" && \
   echo "=== memory ===" && free -h'
```

Expected:
- Rebates `/health` returns `{ok: true, ...}`
- Optimism + MegaETH version JSONs print
- `free -h` shows several GB available

### Step 5: No commit (VM-side state).

---

## Task 10: Create the Optimism Sepolia Cloudflare Tunnel

**Files:**
- Create on VM: `/root/.cloudflared/<UUID>-optimism-sepolia.json`
- Create on VM: `/etc/cloudflared/optimism-sepolia.yml`
- Create CF DNS record: `optimism-sepolia.ophis.fi`

### Step 1: Create the tunnel via cert.pem (already on VM from rebates work)

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cloudflared tunnel create ophis-optimism-sepolia 2>&1 | tee /tmp/tunnel-create-optimism.log | tail -5'
```

Expected output ending with:
```
Tunnel credentials written to /root/.cloudflared/<UUID>.json
Created tunnel ophis-optimism-sepolia with id <UUID>
```

Capture the UUID for the next step.

### Step 2: Write the cloudflared config for this tunnel

```bash
TUNNEL_UUID=$(ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'grep -oE "id [a-f0-9-]+" /tmp/tunnel-create-optimism.log | awk "{print \$2}"')
echo "Optimism tunnel UUID: $TUNNEL_UUID"

ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  "cat > /etc/cloudflared/optimism-sepolia.yml <<EOF
tunnel: ${TUNNEL_UUID}
credentials-file: /root/.cloudflared/${TUNNEL_UUID}.json
ingress:
  - hostname: optimism-sepolia.ophis.fi
    service: http://localhost:8100
  - service: http_status:404
EOF
cat /etc/cloudflared/optimism-sepolia.yml"
```

Expected: config file contents print, ingress block matches above.

### Step 3: Add the proxied CNAME via Cloudflare API

```bash
CF_TOKEN=$(security find-generic-password -l "cloudflare-api-token" -w)
TUNNEL_UUID=<paste from Step 2>
ZONE_ID="dd7588af506387891f094a4927e11d7a"  # ophis.fi zone

curl -sS -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -d "{\"type\":\"CNAME\",\"name\":\"optimism-sepolia\",\"content\":\"${TUNNEL_UUID}.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}" \
  | jq '{success, errors, name: .result.name, content: .result.content, proxied: .result.proxied}'
```

Expected: `success: true`, no errors, the CNAME is recorded.

### Step 4: No commit (tunnel + DNS are CF-side state).

---

## Task 11: Create the MegaETH testnet Cloudflare Tunnel

Same as Task 10 but for MegaETH:

### Step 1: Create the tunnel

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cloudflared tunnel create ophis-megaeth-testnet 2>&1 | tee /tmp/tunnel-create-megaeth.log | tail -5'
```

Capture the UUID.

### Step 2: Write the config

```bash
TUNNEL_UUID=$(ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'grep -oE "id [a-f0-9-]+" /tmp/tunnel-create-megaeth.log | awk "{print \$2}"')
echo "MegaETH tunnel UUID: $TUNNEL_UUID"

ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  "cat > /etc/cloudflared/megaeth-testnet.yml <<EOF
tunnel: ${TUNNEL_UUID}
credentials-file: /root/.cloudflared/${TUNNEL_UUID}.json
ingress:
  - hostname: megaeth-testnet.ophis.fi
    service: http://localhost:8082
  - service: http_status:404
EOF
cat /etc/cloudflared/megaeth-testnet.yml"
```

### Step 3: Add the CNAME

```bash
CF_TOKEN=$(security find-generic-password -l "cloudflare-api-token" -w)
TUNNEL_UUID=<paste from Step 2>
ZONE_ID="dd7588af506387891f094a4927e11d7a"

curl -sS -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -d "{\"type\":\"CNAME\",\"name\":\"megaeth-testnet\",\"content\":\"${TUNNEL_UUID}.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}" \
  | jq '{success, errors, name: .result.name, content: .result.content}'
```

Expected: `success: true`.

### Step 4: No commit.

---

## Task 12: Install both cloudflared systemd units

**Files:**
- Create on VM: `/etc/systemd/system/cloudflared-optimism-sepolia.service`
- Create on VM: `/etc/systemd/system/cloudflared-megaeth-testnet.service`

### Step 1: Write the Optimism Sepolia systemd unit

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cat > /etc/systemd/system/cloudflared-optimism-sepolia.service <<EOF
[Unit]
Description=cloudflared for optimism-sepolia.ophis.fi
After=network.target

[Service]
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /etc/cloudflared/optimism-sepolia.yml tunnel run
Restart=on-failure
RestartSec=5s
User=root

[Install]
WantedBy=multi-user.target
EOF
echo "wrote unit"'
```

### Step 2: Write the MegaETH testnet systemd unit

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'cat > /etc/systemd/system/cloudflared-megaeth-testnet.service <<EOF
[Unit]
Description=cloudflared for megaeth-testnet.ophis.fi
After=network.target

[Service]
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /etc/cloudflared/megaeth-testnet.yml tunnel run
Restart=on-failure
RestartSec=5s
User=root

[Install]
WantedBy=multi-user.target
EOF
echo "wrote unit"'
```

### Step 3: Enable + start both services

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'systemctl daemon-reload && \
   systemctl enable --now cloudflared-optimism-sepolia.service cloudflared-megaeth-testnet.service && \
   sleep 5 && \
   systemctl status cloudflared-optimism-sepolia.service cloudflared-megaeth-testnet.service --no-pager | head -25'
```

Expected: both services show `active (running)`. The journal should show `Registered tunnel connection`.

### Step 4: Verify the public endpoints

```bash
echo "=== optimism-sepolia ===" && \
  curl -fsS https://optimism-sepolia.ophis.fi/api/v1/version | jq -c '{version, commit}' && \
echo "=== megaeth-testnet ===" && \
  curl -fsS https://megaeth-testnet.ophis.fi/api/v1/version | jq -c '{version, commit}'
```

Expected: both return version JSON over HTTPS.

### Step 5: No commit (VM-side state).

---

## Task 13: Document the runbook

**Files:**
- Create: `infra/cloudflare/ophis-chain-backends.md`

### Step 1: Write the runbook

```bash
cd /Users/scep/greg
cat > infra/cloudflare/ophis-chain-backends.md <<'EOF'
# `<chain>.ophis.fi` — chain backend runbook (Spec 1)

## SSH

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26
```

Co-tenants on this VM (don't disturb each other):
- `apps/rebate-indexer/` at `/srv/ophis/apps/rebate-indexer/` — public `rebates.ophis.fi`, on host port 8080
- `infra/optimism/` at `/srv/ophis/infra/optimism/` — public `optimism-sepolia.ophis.fi`, on host port 8100
- `infra/megaeth/` at `/srv/ophis/infra/megaeth/` — public `megaeth-testnet.ophis.fi`, on host port 8082

## Logs

Per-container, last 100 lines:
```bash
docker logs --tail 100 optimism-orderbook-1
docker logs --tail 100 optimism-driver-1
# autopilot, baseline, postgres similarly named
```

cloudflared logs:
```bash
journalctl -u cloudflared-optimism-sepolia.service -n 100
journalctl -u cloudflared-megaeth-testnet.service -n 100
```

## Single-chain restart (without affecting the other or rebate-indexer)

```bash
cd /srv/ophis/infra/optimism
docker compose -f docker-compose.testnet.yml restart
# Or, to fully recreate:
docker compose -f docker-compose.testnet.yml down
docker compose -f docker-compose.testnet.yml --env-file /srv/ophis/.env.shared up -d
```

The compose project name is scoped by directory; restarting `optimism` doesn't touch `megaeth` containers.

## Adding a third chain (template)

When Spec 2/3 promote to mainnet (or a new testnet) the same pattern repeats:

1. Create `infra/<chain>/docker-compose.testnet.yml` (or `.mainnet.yml`) using port range that doesn't collide. Reserved so far: 8080 (rebates), 8100/8101 (optimism), 8082/8083 (megaeth).
2. `rsync` to `/srv/ophis/infra/<chain>/`
3. `docker compose build`, then `up -d` with `--env-file /srv/ophis/.env.shared`
4. `cloudflared tunnel create ophis-<chain>`, write `/etc/cloudflared/<chain>.yml`
5. Add a CNAME `<chain>.ophis.fi → <UUID>.cfargotunnel.com` proxied via the CF API
6. Write `/etc/systemd/system/cloudflared-<chain>.service`, `systemctl enable --now`

## Where the secrets live

- Driver-submitter EOA private key: `/srv/ophis/.env.shared`, key `DRIVER_SUBMITTER_PRIVATE_KEY`. Mode 600. Sourced from macOS Keychain entry `ophis-driver-submitter` at deploy time.
- Cloudflare API token: GitHub secret `CLOUDFLARE_API_TOKEN`, macOS Keychain `cloudflare-api-token`. Same token as the rebate-indexer.
- Cloudflare tunnel cert.pem: `/root/.cloudflared/cert.pem` on the VM. Created once during the rebate-indexer revival; reused by all subsequent tunnels.

## Smoke tests

```bash
cd /srv/ophis/infra/optimism/scripts && pnpm tsx smoke-test-e2e.ts
cd /srv/ophis/infra/megaeth/scripts && pnpm tsx smoke-test-e2e.ts
```

Optimism Sepolia: should print `✓ E2E passed, settlement tx 0x<hash>` and exit 0.
MegaETH testnet: should print `✓ simulated, sequencer-bug stop expected` and exit 0 (per the known upstream bug — D5).
EOF

git add infra/cloudflare/ophis-chain-backends.md
git commit -m "docs(infra): operator runbook for chain-backend co-tenancy on rebates VM"
```

### Step 2: No further action.

---

## Task 14: Smoke-test scripts skeleton (npm + tsconfig)

**Files:**
- Create: `infra/optimism/scripts/package.json`
- Create: `infra/optimism/scripts/tsconfig.json`
- Create: `infra/megaeth/scripts/package.json`
- Create: `infra/megaeth/scripts/tsconfig.json`

### Step 1: Write `infra/optimism/scripts/package.json`

```json
{
  "name": "@ophis/infra-optimism-scripts",
  "private": true,
  "type": "module",
  "scripts": {
    "smoke": "tsx smoke-test-e2e.ts"
  },
  "dependencies": {
    "@cowprotocol/cow-sdk": "^5.0.0",
    "viem": "^2.21.0",
    "chalk": "^5.3.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.0"
  }
}
```

### Step 2: Write `infra/optimism/scripts/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["./*.ts"]
}
```

### Step 3: Same two files for `infra/megaeth/scripts/`

Copy the two files from `infra/optimism/scripts/` to `infra/megaeth/scripts/`, change the `name` field in `package.json` to `@ophis/infra-megaeth-scripts`.

### Step 4: Install deps locally (we won't run on the VM; smoke tests are run from Mac)

```bash
cd /Users/scep/greg/infra/optimism/scripts
pnpm install
cd /Users/scep/greg/infra/megaeth/scripts
pnpm install
```

Expected: both install successfully. Node modules are gitignored at the repo root.

### Step 5: Commit

```bash
cd /Users/scep/greg
git add infra/optimism/scripts/package.json infra/optimism/scripts/tsconfig.json
git add infra/megaeth/scripts/package.json infra/megaeth/scripts/tsconfig.json
git commit -m "feat(infra): bootstrap smoke-test scripts npm/tsx scaffolding"
```

---

## Task 15: Write the Optimism Sepolia E2E smoke test

**Files:**
- Create: `infra/optimism/scripts/smoke-test-e2e.ts`

### Step 1: Write the script

```ts
// infra/optimism/scripts/smoke-test-e2e.ts
//
// Programmatic end-to-end smoke test of the Optimism Sepolia chain
// backend. Signs a WETH→GTUSD order with a test wallet, posts to
// optimism-sepolia.ophis.fi/api/v1/orders, polls for settlement,
// verifies the on-chain settlement tx.
//
// Exits 0 on full success, 1 on any failure.

import { OrderBookApi, SupportedChainId, OrderKind, OrderSigningUtils } from '@cowprotocol/cow-sdk';
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import chalk from 'chalk';

// Optimism Sepolia chain definition for viem
const OPTIMISM_SEPOLIA = {
  ...sepolia,
  id: 11155420,
  name: 'Optimism Sepolia',
  rpcUrls: { default: { http: ['https://sepolia.optimism.io'] } },
} as const;

const ORDERBOOK_URL = 'https://optimism-sepolia.ophis.fi';
const SETTLEMENT = '0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce' as const;
const VAULT_RELAYER = '0x842F655C9310C32e5932A0eBFa80c4Cd358c0205' as const;
const WETH = process.env.OPTIMISM_SEPOLIA_WETH as `0x${string}` ?? '0x4200000000000000000000000000000000000006';
const GTUSD = process.env.OPTIMISM_SEPOLIA_GTUSD as `0x${string}`;
const TEST_PK = process.env.OPTIMISM_SEPOLIA_TEST_WALLET_PK as `0x${string}`;

if (!GTUSD) {
  console.error(chalk.red('Missing env OPTIMISM_SEPOLIA_GTUSD — set to the Ophis-deployed GTUSD test-token address'));
  process.exit(2);
}
if (!TEST_PK) {
  console.error(chalk.red('Missing env OPTIMISM_SEPOLIA_TEST_WALLET_PK — set to a Sepolia-funded private key holding WETH'));
  process.exit(2);
}

const account = privateKeyToAccount(TEST_PK);
console.log(chalk.dim(`test wallet: ${account.address}`));

const publicClient = createPublicClient({ chain: OPTIMISM_SEPOLIA, transport: http() });
const walletClient = createWalletClient({ account, chain: OPTIMISM_SEPOLIA, transport: http() });

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

async function main() {
  console.log(chalk.cyan('=== Optimism Sepolia E2E smoke test ==='));

  // Step 1: Check WETH balance
  const wethContract = getContract({ address: WETH, abi: ERC20_ABI, client: publicClient });
  const wethBalance = await wethContract.read.balanceOf([account.address]);
  console.log(chalk.dim(`WETH balance: ${wethBalance}`));
  if (wethBalance < parseEther('0.001')) {
    console.error(chalk.red('Insufficient WETH (need ≥ 0.001) — fund via faucet or wrap ETH'));
    process.exit(1);
  }

  // Step 2: Approve VaultRelayer if not already
  const allowance = await wethContract.read.allowance([account.address, VAULT_RELAYER]);
  if (allowance < parseEther('0.001')) {
    console.log(chalk.yellow('Approving VaultRelayer...'));
    const txHash = await walletClient.writeContract({
      address: WETH,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VAULT_RELAYER, parseEther('1000')],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(chalk.green(`  ✓ approved (tx ${txHash})`));
  }

  // Step 3: Build + sign order via cow-sdk
  const orderBookApi = new OrderBookApi({
    chainId: 11155420 as unknown as SupportedChainId, // optimism-sepolia
    backendUrl: ORDERBOOK_URL,
  });

  const sellAmount = parseEther('0.001'); // 0.001 WETH
  const buyAmount = parseUnits('2', 18); // 2 GTUSD minimum

  const order = {
    sellToken: WETH,
    buyToken: GTUSD,
    receiver: account.address,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    validTo: Math.floor(Date.now() / 1000) + 30 * 60,
    feeAmount: '0',
    kind: OrderKind.SELL,
    partiallyFillable: false,
    appData: '{"appCode":"ophis"}',
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  };

  console.log(chalk.yellow('Signing order...'));
  const signature = await OrderSigningUtils.signOrder(order as any, 11155420, walletClient as any);

  // Step 4: Submit
  console.log(chalk.yellow('Submitting to orderbook...'));
  const orderUid = await orderBookApi.sendOrder({ ...order, ...signature, from: account.address } as any);
  console.log(chalk.green(`  ✓ order accepted, uid ${orderUid}`));

  // Step 5: Poll for settlement (max 5 min)
  console.log(chalk.yellow('Polling for settlement (up to 5 min)...'));
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const status = await orderBookApi.getOrder(orderUid);
    if (status.status === 'fulfilled') {
      const trades = await orderBookApi.getTrades({ orderUid });
      const settlementTx = trades[0]?.txHash;
      if (!settlementTx) {
        console.error(chalk.red('Order fulfilled but no settlement tx returned'));
        process.exit(1);
      }
      console.log(chalk.green(`  ✓ E2E passed, settlement tx ${settlementTx}`));
      console.log(chalk.dim(`  https://sepolia-optimism.etherscan.io/tx/${settlementTx}`));
      process.exit(0);
    }
    if (status.status === 'cancelled' || status.status === 'expired') {
      console.error(chalk.red(`Order ${status.status}`));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  console.error(chalk.red('Timed out waiting for settlement'));
  process.exit(1);
}

main().catch((err) => {
  console.error(chalk.red('Smoke test failed:'), err);
  process.exit(1);
});
```

### Step 2: Run the smoke test (this is also Task 16's gate)

```bash
cd /Users/scep/greg/infra/optimism/scripts
export OPTIMISM_SEPOLIA_GTUSD=<paste from infra/optimism/.env.example>
export OPTIMISM_SEPOLIA_TEST_WALLET_PK=$(security find-generic-password -l ophis-chiado-test -w)
pnpm smoke 2>&1 | tee /tmp/smoke-optimism.log
```

Expected: green checkmarks all the way through, ends with `✓ E2E passed, settlement tx 0x<hash>` and exits 0.

If something fails (most likely point: WETH balance insufficient or test wallet not on Optimism Sepolia), top up the wallet via Optimism Sepolia faucet, wrap ETH if needed, and retry.

### Step 3: Commit

```bash
cd /Users/scep/greg
git add infra/optimism/scripts/smoke-test-e2e.ts
git commit -m "feat(infra): Optimism Sepolia E2E smoke-test script"
```

---

## Task 16: Write the MegaETH testnet partial smoke test

**Files:**
- Create: `infra/megaeth/scripts/smoke-test-e2e.ts`

### Step 1: Write the script

```ts
// infra/megaeth/scripts/smoke-test-e2e.ts
//
// Programmatic end-to-end smoke test of the MegaETH testnet chain backend.
//
// MegaETH testnet has a documented sequencer bug rejecting valid EIP-1559
// settlement txs ("Cannot read properties of undefined (reading 'length')").
// The expected success state stops at "driver simulated OK" — the orderbook
// accepts the order, the driver simulates settlement, but the on-chain
// submission fails at the upstream sequencer. Per spec D5: exits 0 on this
// expected state, 1 on any other failure (including the case where MegaETH
// unexpectedly settles — that would invalidate our 'known bug' annotation
// and is worth a louder signal than silent success).

import { OrderBookApi, SupportedChainId, OrderKind, OrderSigningUtils } from '@cowprotocol/cow-sdk';
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import chalk from 'chalk';

const MEGAETH_TESTNET = {
  ...sepolia,
  id: 6343,
  name: 'MegaETH Testnet',
  rpcUrls: { default: { http: ['https://carrot.megaeth.com/rpc'] } },
} as const;

const ORDERBOOK_URL = 'https://megaeth-testnet.ophis.fi';
const SETTLEMENT = '0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce' as const;
const VAULT_RELAYER = '0x842F655C9310C32e5932A0eBFa80c4Cd358c0205' as const;
const WETH = process.env.MEGAETH_TESTNET_WETH as `0x${string}` ?? '0x4200000000000000000000000000000000000006';
const GTUSD = process.env.MEGAETH_TESTNET_GTUSD as `0x${string}`;
const TEST_PK = process.env.MEGAETH_TESTNET_TEST_WALLET_PK as `0x${string}`;

if (!GTUSD) {
  console.error(chalk.red('Missing env MEGAETH_TESTNET_GTUSD — set to the Ophis-deployed GTUSD test-token address (see infra/megaeth/.env.example)'));
  process.exit(2);
}
if (!TEST_PK) {
  console.error(chalk.red('Missing env MEGAETH_TESTNET_TEST_WALLET_PK — set to a MegaETH-testnet-funded private key'));
  process.exit(2);
}

const account = privateKeyToAccount(TEST_PK);
console.log(chalk.dim(`test wallet: ${account.address}`));

const publicClient = createPublicClient({ chain: MEGAETH_TESTNET, transport: http() });
const walletClient = createWalletClient({ account, chain: MEGAETH_TESTNET, transport: http() });

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

async function main() {
  console.log(chalk.cyan('=== MegaETH testnet E2E smoke test ==='));
  console.log(chalk.dim('Expected: stops at "driver simulated OK" due to known sequencer bug.'));

  // Step 1: WETH balance check
  const wethContract = getContract({ address: WETH, abi: ERC20_ABI, client: publicClient });
  const wethBalance = await wethContract.read.balanceOf([account.address]);
  console.log(chalk.dim(`WETH balance: ${wethBalance}`));
  if (wethBalance < parseEther('0.001')) {
    console.error(chalk.red('Insufficient WETH (need ≥ 0.001) — fund via faucet at testnet.megaeth.com'));
    process.exit(1);
  }

  // Step 2: Approve VaultRelayer
  const allowance = await wethContract.read.allowance([account.address, VAULT_RELAYER]);
  if (allowance < parseEther('0.001')) {
    console.log(chalk.yellow('Approving VaultRelayer...'));
    const txHash = await walletClient.writeContract({
      address: WETH,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VAULT_RELAYER, parseEther('1000')],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(chalk.green(`  ✓ approved (tx ${txHash})`));
  }

  // Step 3: Build + sign order via cow-sdk
  const orderBookApi = new OrderBookApi({
    chainId: 6343 as unknown as SupportedChainId, // megaeth-testnet (not in upstream enum)
    backendUrl: ORDERBOOK_URL,
  });

  const sellAmount = parseEther('0.001');
  const buyAmount = parseUnits('2', 18);

  const order = {
    sellToken: WETH,
    buyToken: GTUSD,
    receiver: account.address,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    validTo: Math.floor(Date.now() / 1000) + 30 * 60,
    feeAmount: '0',
    kind: OrderKind.SELL,
    partiallyFillable: false,
    appData: '{"appCode":"ophis"}',
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  };

  console.log(chalk.yellow('Signing order...'));
  const signature = await OrderSigningUtils.signOrder(order as any, 6343, walletClient as any);

  // Step 4: Submit
  console.log(chalk.yellow('Submitting to orderbook...'));
  const orderUid = await orderBookApi.sendOrder({ ...order, ...signature, from: account.address } as any);
  console.log(chalk.green(`  ✓ order accepted, uid ${orderUid}`));

  // Step 5: Poll. Expected MegaETH success state: order stays open while the
  // driver competition shows a successful simulation. Unexpected: order
  // reaches 'fulfilled' (means the sequencer bug is gone — louder signal).
  console.log(chalk.yellow('Polling competitions (up to 3 min)...'));
  const deadline = Date.now() + 3 * 60_000;
  let driverSimulatedOK = false;
  while (Date.now() < deadline) {
    const status = await orderBookApi.getOrder(orderUid);
    if (status.status === 'fulfilled') {
      console.error(chalk.red('Unexpected: MegaETH testnet settled the order. Sequencer bug may have been fixed upstream — update the spec\'s "known bug" annotation and switch this script\'s exit code logic.'));
      process.exit(1);
    }
    if (status.status === 'cancelled' || status.status === 'expired') {
      console.error(chalk.red(`Order ${status.status}`));
      process.exit(1);
    }
    // Check the driver-simulated state via the competition endpoint
    try {
      const competition = await fetch(`${ORDERBOOK_URL}/api/v1/orders/${orderUid}/competition`).then((r) => r.json() as any);
      const hasSimulation = competition?.solutions?.some((s: any) => s.simulationOk === true);
      if (hasSimulation) {
        driverSimulatedOK = true;
        console.log(chalk.green('  ✓ driver simulated OK (settlement-side sequencer-bug stop expected)'));
        break;
      }
    } catch { /* competition endpoint flaky; poll again */ }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  if (driverSimulatedOK) {
    console.log(chalk.green('✓ simulated, sequencer-bug stop expected (exit 0 per D5)'));
    process.exit(0);
  }

  console.error(chalk.red('Timed out without observing driver-simulated state — backend may be unhealthy'));
  process.exit(1);
}

main().catch((err) => {
  console.error(chalk.red('Smoke test failed:'), err);
  process.exit(1);
});
```

### Step 2: Run

```bash
cd /Users/scep/greg/infra/megaeth/scripts
export MEGAETH_TESTNET_GTUSD=<paste from infra/megaeth/.env.example>
export MEGAETH_TESTNET_TEST_WALLET_PK=$(security find-generic-password -l ophis-megaeth-deployer -w)
pnpm smoke 2>&1 | tee /tmp/smoke-megaeth.log
```

Expected: ends with `✓ simulated, sequencer-bug stop expected (exit 0)`.

### Step 3: Commit

```bash
cd /Users/scep/greg
git add infra/megaeth/scripts/smoke-test-e2e.ts
git commit -m "feat(infra): MegaETH testnet partial smoke-test (sequencer-bug aware)"
```

---

## Task 17: Update memory `project_greg.md`

**Files:**
- Modify: `/Users/scep/.claude/projects/-Users-scep/memory/project_greg.md`

### Step 1: Read the current "Phase 3.5 — Aleph VM hosting" section

```bash
grep -n "Phase 3.5" /Users/scep/.claude/projects/-Users-scep/memory/project_greg.md
```

Open the section starting at that line. It currently describes the old VM at `149.86.227.106:24019`.

### Step 2: Replace the section content

Replace the old VM-specific paragraphs with:

```markdown
## Phase 3.5 — Aleph VM hosting (updated 2026-05-11)

Ophis's multi-chain testnet stack now runs as a **co-tenant on the rebates VM**
at `vm4.alephvision.eu` (`45.144.209.26:24014`) — same VM, same SSH key
(`~/.ssh/aleph-greg`), same Cloudflare account. Replaces the deceased Phase 3
VM at `149.86.227.106:24019` (instance presumed reclaimed by Aleph).

- **Repo:** `/srv/ophis/` (rsync'd from Mac; same path that hosts the
  rebate-indexer).
- **Backend images:** built on the VM via `docker compose -f
  /srv/ophis/infra/<chain>/docker-compose.testnet.yml build`.
- **Live chain stacks (2):** optimism-sepolia (host ports 8100/8101/9021/5434),
  megaeth-testnet (remapped host ports 8082/8083/9001/5432 — was 8080/8081
  before co-tenancy collided with the rebate-indexer). Linea Sepolia dropped
  (CoW serves Linea natively).
- **External exposure:** per-chain named Cloudflare Tunnels via
  `optimism-sepolia.ophis.fi` + `megaeth-testnet.ophis.fi`. Each runs
  as its own systemd unit (`cloudflared-<chain>.service`). Stable URLs, no
  `*.trycloudflare.com` rotation.
- **Driver-submitter PK** lives at `/srv/ophis/.env.shared` (mode 600).
  Sourced from macOS Keychain `ophis-driver-submitter`.
- **Runbook:** `infra/cloudflare/ophis-chain-backends.md`.
```

### Step 3: Also update the "Open operational tasks" section

Find the line about `**Phase 3.5 named-tunnel decision**` and remove it (already done by Spec 1).

### Step 4: No git commit (memory file is outside the repo). Save it.

---

## Task 18: Telegram alert + done-criteria summary

**Files:**
- Local script run: a one-shot Telegram message via existing alerter

### Step 1: Use the existing rebate-indexer Telegram alerter to send a "revived" message

```bash
cd /Users/scep/greg/apps/rebate-indexer
pnpm tsx -e '
import { alerts } from "./src/telegram/alerter.js";
await alerts.alert("chain-backends", "🟢 Spec 1 done — optimism-sepolia + megaeth-testnet revived on vm4; /api/v1/version healthy on both subdomains; Optimism Sepolia E2E settled");
'
```

Expected: message lands in Clement's Telegram DM (chat `735726338`).

### Step 2: No commit.

---

## Task 19: Final verification + done-checklist sign-off

**Files:**
- No file changes. Walk the spec's done-checklist top to bottom.

### Step 1: Live state on the VM

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26 \
  'echo "=== optimism ===" && \
   docker compose -f /srv/ophis/infra/optimism/docker-compose.testnet.yml ps && \
   echo "=== megaeth ===" && \
   docker compose -f /srv/ophis/infra/megaeth/docker-compose.testnet.yml ps && \
   echo "=== rebates ===" && \
   docker compose -f /srv/ophis/apps/rebate-indexer/docker-compose.yml ps && \
   echo "=== memory ===" && \
   free -h'
```

Verify:
- [ ] Optimism: 5 containers running + healthy, migrations exited 0
- [ ] MegaETH: 5 containers running + healthy, migrations exited 0
- [ ] Rebates: still healthy
- [ ] `free -h` shows ≥ 4 GB free

### Step 2: Public endpoints

```bash
echo "=== /version optimism ===" && \
  curl -fsS https://optimism-sepolia.ophis.fi/api/v1/version | jq && \
echo "=== /version megaeth ===" && \
  curl -fsS https://megaeth-testnet.ophis.fi/api/v1/version | jq && \
echo "=== rebates /health ===" && \
  curl -fsS https://rebates.ophis.fi/health | jq
```

Verify:
- [ ] Both chain-backend /version return 200 + JSON
- [ ] Rebates /health unchanged

### Step 3: E2E smoke test re-run (reproducibility check)

```bash
cd /Users/scep/greg/infra/optimism/scripts
pnpm smoke 2>&1 | tail -5
```

Verify:
- [ ] Exits 0 with `✓ E2E passed, settlement tx 0x<hash>`
- [ ] Tx hash is fresh (different from the first run)

### Step 4: MegaETH testnet partial validation re-run

```bash
cd /Users/scep/greg/infra/megaeth/scripts
pnpm smoke 2>&1 | tail -5
```

Verify:
- [ ] Exits 0 with `✓ simulated, sequencer-bug stop expected`

### Step 5: Repo state

```bash
cd /Users/scep/greg
git log --oneline main..HEAD | head -20
grep -l LineaSepolia apps/backend/ 2>/dev/null || echo "✓ no Linea references in apps/backend/"
test -d infra/linea/ && echo "✗ infra/linea/ still exists" || echo "✓ infra/linea/ deleted"
```

Verify:
- [ ] Several conventional-commit-style commits on the branch
- [ ] No `LineaSepolia` in `apps/backend/`
- [ ] `infra/linea/` gone

### Step 6: Memory updated

```bash
grep "Phase 3.5" /Users/scep/.claude/projects/-Users-scep/memory/project_greg.md | head
```

Verify:
- [ ] Reflects "updated 2026-05-11" + vm4 co-tenancy

### Step 7: All-done commit + push + PR

```bash
cd /Users/scep/greg
git push -u origin spec/backend-revival
gh pr create --repo ophis-fi/ophis --base main --head spec/backend-revival \
  --title "feat: Phase 4 Spec 1 — chain backend revival + Linea cleanup" \
  --body "$(cat <<'BODY'
Spec 1 of 3 in the Phase 4 sovereign-orderbook arc. Revives the dead
Phase 3 chain-backend stack by co-tenanting Optimism Sepolia +
MegaETH testnet onto the rebates VM. Drops Linea (CoW serves it
natively).

Spec: docs/development/specs/2026-05-11-spec-1-backend-revival.md
Plan: docs/development/plans/2026-05-11-spec-1-backend-revival.md

Done-checklist verified (see Task 19). E2E settled on Optimism
Sepolia at tx <hash>. MegaETH stops at expected sequencer-bug per D5.

Next: Spec 2 — sovereign Optimism mainnet.
BODY
)"
```

Verify:
- [ ] PR opens cleanly

---

## Self-review (spec → plan coverage check)

| Spec section | Where covered in plan |
|---|---|
| §Goals: 2 chain stacks running on rebates VM | Tasks 8 (optimism boot) + 9 (megaeth boot) |
| §Goals: 2 named CF tunnels live | Tasks 10 (optimism tunnel) + 11 (megaeth tunnel) + 12 (systemd units) |
| §Goals: programmatic E2E settled on Optimism Sepolia | Task 15 (write + run) + 19 Step 3 (re-run for reproducibility) |
| §Goals: infra/linea/ removed | Task 1 |
| §Goals: Phase-3 validation annotated | Task 4 |
| §Goals: rebate-indexer uninterrupted | Tasks 3 (mem_limit), 9 Step 4 (sanity check), 19 Step 2 (post-deploy check) |
| §Architecture: co-tenancy on rebates VM | Tasks 5-9 |
| §Components: 4 services × 2 chains + 2 Postgres | Tasks 6 (build), 8-9 (boot) |
| §Components: key existing artifacts (settlement, vault-relayer, V2 fork pools, driver EOA) | Tasks 7 (PK injection), 15 (uses Settlement + VaultRelayer addresses) |
| §Revival sequence Stage A | Tasks 1-4 |
| §Revival sequence Stage B | Task 5 |
| §Revival sequence Stage C | Task 6 |
| §Revival sequence Stage D | Tasks 7, 8, 9 |
| §Revival sequence Stage E | Tasks 10, 11, 12 |
| §Revival sequence Stage F | Tasks 14, 15, 16 |
| §Risk: tunnel cert.pem auth | Tasks 10/11 reuse the existing `/root/.cloudflared/cert.pem` (already on VM from rebates work) |
| §Risk: docker network name collision | Implicit via compose-project-name isolation (each compose dir = own network) |
| §Done-checklist: every box | Task 19 walks the full checklist |
| §Open questions D1-D5 | All locked at the top of this plan |

No gaps.

**Placeholder scan:** searched for TBD / TODO / FIXME / "fill in" / "Similar to Task" — no hits. Task 16's MegaETH script is fully written out so an Implementer reading only Task 16 has complete code.

**Type consistency:** spot-checked function names, container names (`optimism-orderbook-1`, `megaeth-orderbook-1`), env var names (`DRIVER_SUBMITTER_PRIVATE_KEY`, `OPTIMISM_SEPOLIA_RPC_URL`, etc.), tunnel UUIDs (passed by env between steps via shell variable) — all consistent across tasks.

---

## Plan complete

Plan saved to `docs/development/plans/2026-05-11-spec-1-backend-revival.md` (19 tasks, ~3-5 days of focused work).
