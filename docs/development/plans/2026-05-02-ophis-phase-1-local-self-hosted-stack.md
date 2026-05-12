# Ophis Phase 1 — Local Self-Hosted Stack Implementation Plan


**Goal:** Stand up Ophis's full self-hosted backend (orderbook + autopilot + driver + baseline solver + Postgres) on Clement's Mac mini, end-to-end-test it against a forked Gnosis mainnet, then point it at *real* Gnosis mainnet RPC and settle one tiny real-money swap (≤ €5).

**Architecture:** Reuse `cowprotocol/services`'s `playground/docker-compose.fork.yml` as the boot template — it ships a working multi-service compose for the entire CoW stack. Phase 1 specialises it for Ophis by: (a) trimming the unneeded UI containers (cowswap, otterscan, sourcify, explorer, grafana, prometheus, tempo), (b) duplicating the compose for a non-forked "real Gnosis mainnet" mode, (c) committing the trimmed configs and a runbook into `infra/local/`. Settlement still rides CoW's audited `GPv2Settlement` contracts — we don't deploy any contracts.

**Tech Stack:** Docker / docker-compose, Postgres 16, Rust (existing services workspace), Anvil (for Stage 1 fork validation), Foundry `cast`, Gnosis mainnet RPC (Alchemy free tier + PublicNode + Ankr fallback), `infra/rpc/fallback.ts` (TS helper for the FE).

**Spec correction (callout):** The spec said "settlements still ride CoW's existing Gnosis solver network" in Phase 1. Engineering reality: CoW's solvers only watch CoW's own orderbook — they will not auto-discover a private Ophis orderbook. Once we self-host the orderbook we must also run autopilot + driver + at least one solver. This plan does that with the upstream `baseline` solver. Spec to be amended in Phase 2 paperwork.

**Phase gate:** A signed Gnosis-mainnet order from a Ophis-funded test wallet, posted to **our** locally-running orderbook on `localhost:8080`, settles via Ophis's autopilot + driver + baseline solver, with an on-chain `GPv2Settlement.settle()` tx visible on Gnosis explorer. Validation log committed to `docs/development/phase-1-validation.md`.

**Spec:** [`docs/development/specs/2026-05-02-ophis-design.md`](../specs/2026-05-02-ophis-design.md)

**Predecessor plan:** [`docs/development/plans/2026-05-02-ophis-phase-0-foundation.md`](2026-05-02-ophis-phase-0-foundation.md)

---

## File Structure (created by this plan)

| Path | Purpose |
|---|---|
| `infra/local/.env.example` | Documented environment template (RPC URLs, DB creds, wallet placeholders) |
| `infra/local/docker-compose.fork.yml` | Stripped-down compose for forked-Gnosis validation (Stage 1) |
| `infra/local/docker-compose.gnosis.yml` | Compose for real Gnosis mainnet runs (no anvil) |
| `infra/local/configs/orderbook.toml` | Ophis orderbook config, Gnosis-targeted |
| `infra/local/configs/autopilot.toml` | Ophis autopilot config |
| `infra/local/configs/driver.toml` | Ophis driver config (with baseline solver) |
| `infra/local/configs/baseline.toml` | Baseline solver config |
| `infra/local/README.md` | Operator runbook (boot order, smoke test, teardown) |
| `infra/rpc/fallback.ts` | `viem` `fallback()` transport: Alchemy → PublicNode → Ankr (Gnosis) |
| `apps/frontend/.env.development.local.example` | Documented FE env template pointing FE at `http://localhost:8080` |
| `docs/development/phase-1-validation.md` | Gate evidence (Stage 1 + Stage 2 logs) |

**Not modified:** `apps/backend/` (vendored upstream — track upstream cleanly via subtree pull). `apps/frontend/` source (only env templates).

---

## Stage Map

This plan has two milestones inside it. **Stage 1** (Tasks 1–6) proves the stack on a forked node — zero real-money risk. **Stage 2** (Tasks 7–11) flips to real Gnosis mainnet for the actual phase gate.

| Task | Stage | Output |
|---|---|---|
| 1 | 1 | `infra/local/` skeleton + Postgres up |
| 2 | 1 | Migrations applied |
| 3 | 1 | Stripped fork-mode compose committed |
| 4 | 1 | Forked-Gnosis stack boots; orderbook responds on `:8080` |
| 5 | 1 | autopilot + driver + baseline solver registered; auctions running |
| 6 | 1 | Forked-Gnosis e2e: a swap with anvil's test wallet settles in the fork |
| 7 | 2 | Real-Gnosis compose + configs committed |
| 8 | 2 | RPC fallback (`infra/rpc/fallback.ts`) implemented + tested |
| 9 | 2 | Test wallet funded with xDAI on Gnosis mainnet (manual, ~€5) |
| 10 | 2 | Real-Gnosis e2e: signed order via Ophis orderbook → settled on Gnosis mainnet |
| 11 | 2 | Validation log + tag `v0.1-phase1` |

---

## Dispatch hints

- **Tasks 1–6:** `backend` agent — Rust/Postgres/docker, no FE involvement.
- **Tasks 7–8, 10:** `backend` agent — config + RPC + e2e.
- **Task 9:** Manual (Clement) — funding the wallet from his existing xDAI source (or USDC bridged).
- **Task 11:** CTO + `pm` agent — close-out + status sweep.

---

## Task 1: Local Postgres + `infra/local/` skeleton

**Files:**
- Create: `infra/local/.env.example`, `infra/local/.gitignore`, `infra/local/README.md` (skeleton)
- Modify: root `.gitignore` (already excludes `.env`; verify `infra/local/.env` is covered)

- [ ] **Step 1: Verify Docker is running**

```bash
docker info | head -3
```
Expected: prints "Server Version" without errors. If Docker isn't running on the Mac mini, start Docker Desktop first.

- [ ] **Step 2: Create directory skeleton**

```bash
mkdir -p /Users/scep/greg/infra/local/configs
cd /Users/scep/greg
```

- [ ] **Step 3: Write `infra/local/.env.example`**

```ini
# infra/local/.env — Ophis Phase 1 local stack environment
# Copy to infra/local/.env and fill in. NEVER commit infra/local/.env.
# ---------------------------------------------------------------
# Postgres (matches docker-compose service)
POSTGRES_USER=greg
POSTGRES_PASSWORD=123
POSTGRES_DB=postgres
DB_WRITE_URL=postgresql://greg:123@db:5432/postgres
DB_READ_URL=postgresql://greg:123@db:5432/postgres

# Stage 1 — forked node (anvil)
FORK_RPC_URL=https://rpc.gnosischain.com    # public RPC, used for the fork base
FORK_BLOCK=                                   # leave blank for "latest"; pin a block for reproducibility

# Stage 2 — real Gnosis mainnet RPC (no anvil)
GNOSIS_RPC_URL=https://gnosis.publicnode.com
GNOSIS_RPC_FALLBACK_1=https://rpc.ankr.com/gnosis
GNOSIS_RPC_FALLBACK_2=https://rpc.gnosischain.com
ETH_RPC_URL=$GNOSIS_RPC_URL                   # services historically reads ETH_RPC_URL

# Ophis test wallet (Phase 0 throwaway). Private key in macOS Keychain entry "greg-chiado-test".
TEST_WALLET_ADDRESS=0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB

# Driver submission account (the EOA that submits settlement txs).
# Stage 1: anvil account[0] — 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# Stage 2: a separately-funded EOA (do not reuse the user wallet)
DRIVER_SUBMITTER_PK=
DRIVER_SUBMITTER_ADDRESS=

# Baseline solver address (autopilot needs to know which EOA the driver submits as)
SOLVER_ACCOUNT_ADDRESS=
```

- [ ] **Step 4: Write `infra/local/.gitignore`**

```gitignore
.env
*.log
volumes/
```

- [ ] **Step 5: Write `infra/local/README.md` skeleton**

```markdown
# Ophis Local Self-Hosted Stack (Phase 1)

This directory contains the operator runbook + configs for running Ophis's
backend (orderbook + autopilot + driver + baseline solver + Postgres)
locally on the Mac mini.

## Two modes
- **Stage 1 — Forked Gnosis:** `docker-compose -f docker-compose.fork.yml up`
  Anvil forks the chain; safe playground, no real money.
- **Stage 2 — Real Gnosis mainnet:** `docker-compose -f docker-compose.gnosis.yml up`
  Real chain, real funds. Phase-gate evidence runs here.

## Prereqs
- Docker Desktop running (≥ 8 GB allocated)
- `apps/backend/` builds locally (Phase 0 prereq — see `apps/backend/.greg-build-notes.md`)
- `infra/local/.env` populated (see `.env.example`)

(Boot order, troubleshooting, and teardown filled in by Tasks 4 / 7 / 11.)
```

- [ ] **Step 6: Commit**

```bash
cd /Users/scep/greg
git add infra/local/
git commit -m "infra(local): scaffold Phase 1 local-stack directory + env template"
git push
```

---

## Task 2: Reuse upstream's Postgres + migrations

**Files:** none modified (we leverage upstream's `apps/backend/docker-compose.yaml` directly).

- [ ] **Step 1: Inspect upstream compose**

```bash
cd /Users/scep/greg/apps/backend
cat docker-compose.yaml | head -50
```
Note: it already defines `db` (Postgres 16), `adminer`, and `migrations` (Flyway). The Postgres user is the host's `$USER` — for our purposes we'll override to `greg` via env when we copy this into our own compose later.

- [ ] **Step 2: Boot the upstream Postgres + migrations standalone**

```bash
cd /Users/scep/greg/apps/backend
docker-compose up -d db adminer migrations
docker-compose ps
```
Expected: `db` running on `:5432`, `adminer` on `:7402`, `migrations` exiting `0` after applying all SQL files.

- [ ] **Step 3: Verify migrations applied**

```bash
docker-compose exec db psql -U "$USER" -d postgres -c '\dt' | head -30
```
Expected: ~30+ tables (orders, trades, auctions, etc.). If 0 tables, check `migrations` container logs: `docker-compose logs migrations`.

- [ ] **Step 4: Open adminer in the browser as a sanity check (optional)**

Visit `http://localhost:7402` — server: `db`, user: `$USER`, db: `postgres`, password empty. Confirm tables visible.

- [ ] **Step 5: Tear down (we'll re-launch from our own compose in Task 4)**

```bash
cd /Users/scep/greg/apps/backend
docker-compose down --volumes
```

- [ ] **Step 6: Commit nothing (this task only validates that migrations work upstream)**

This task produces no new files; its output is confidence that the migration system works on this machine.

---

## Task 3: Stripped-down Stage-1 (fork-mode) compose

**Files:**
- Create: `infra/local/docker-compose.fork.yml`
- Create: `infra/local/configs/orderbook.toml` (initially copied from upstream playground, then trimmed)
- Create: `infra/local/configs/autopilot.toml`
- Create: `infra/local/configs/driver.toml`
- Create: `infra/local/configs/baseline.toml`

- [ ] **Step 1: Copy upstream playground configs as starting points**

```bash
cd /Users/scep/greg
cp apps/backend/playground/configs/orderbook.toml infra/local/configs/orderbook.toml
cp apps/backend/playground/configs/autopilot.toml  infra/local/configs/autopilot.toml
cp apps/backend/playground/configs/driver.toml      infra/local/configs/driver.toml
cp apps/backend/playground/configs/baseline.toml    infra/local/configs/baseline.toml
```

- [ ] **Step 2: Open each config and read it carefully**

Read `apps/backend/playground/autopilot.toml` (the playground root variant — there are two copies in the upstream tree). Compare to `apps/backend/playground/configs/autopilot.toml`. The configs reference `%DB_WRITE_URL`, `%DB_READ_URL` placeholders that the docker-compose substitutes via env.

For Ophis, no edits needed at this stage — we keep the playground configs exactly so Stage-1 boots vanilla. We'll diverge in Task 7.

- [ ] **Step 3: Write `infra/local/docker-compose.fork.yml`**

This compose mirrors `apps/backend/playground/docker-compose.fork.yml` but **drops** these containers:
- `cowswap` / `cowswap-frontend` (we have our own)
- `otterscan`, `sourcify` (block explorer, irrelevant for our gate)
- `grafana`, `prometheus`, `tempo` (Phase 2 deliverable)

Read `apps/backend/playground/docker-compose.fork.yml` first to identify the relevant service names and their env. Then write a trimmed version (keeping only `chain`, `db`, `migrations`, `orderbook`, `autopilot`, `driver`, `baseline`):

```yaml
# infra/local/docker-compose.fork.yml
# Ophis Stage-1 stack — anvil-forked Gnosis. No UIs, no observability containers.
# Boot: docker-compose -f infra/local/docker-compose.fork.yml --env-file infra/local/.env up

services:
  chain:
    build:
      context: ../../apps/backend/playground
      dockerfile: Dockerfile.chain
    environment:
      ETH_RPC_URL: ${FORK_RPC_URL}
      FORK_BLOCK: ${FORK_BLOCK:-latest}
    ports:
      - "8545:8545"

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - postgres:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  migrations:
    build:
      context: ../../apps/backend
      target: migrations
    depends_on:
      - db
    environment:
      FLYWAY_URL: jdbc:postgresql://db/?user=${POSTGRES_USER}&password=${POSTGRES_PASSWORD}
    command: migrate
    volumes:
      - ../../apps/backend/database/sql:/flyway/sql
      - ../../apps/backend/database/conf:/flyway/conf

  orderbook:
    build:
      context: ../../apps/backend
      dockerfile: Dockerfile
      target: orderbook
    depends_on: [db, migrations, chain]
    environment:
      DB_WRITE_URL: ${DB_WRITE_URL}
      DB_READ_URL: ${DB_READ_URL}
      ETH_RPC_URL: http://chain:8545
    volumes:
      - ./configs/orderbook.toml:/orderbook.toml:ro
    command: ["--config", "/orderbook.toml"]
    ports:
      - "8080:8080"

  autopilot:
    build:
      context: ../../apps/backend
      dockerfile: Dockerfile
      target: autopilot
    depends_on: [db, migrations, chain, orderbook]
    environment:
      DB_WRITE_URL: ${DB_WRITE_URL}
      DB_READ_URL: ${DB_READ_URL}
      ETH_RPC_URL: http://chain:8545
    volumes:
      - ./configs/autopilot.toml:/autopilot.toml:ro
    command: ["--config", "/autopilot.toml"]

  driver:
    build:
      context: ../../apps/backend
      dockerfile: Dockerfile
      target: driver
    depends_on: [chain, baseline]
    environment:
      ETH_RPC_URL: http://chain:8545
    volumes:
      - ./configs/driver.toml:/driver.toml:ro
    command: ["--config", "/driver.toml"]
    ports:
      - "8081:80"

  baseline:
    build:
      context: ../../apps/backend
      dockerfile: Dockerfile
      target: solvers
    volumes:
      - ./configs/baseline.toml:/baseline.toml:ro
    command: ["baseline", "--config", "/baseline.toml"]

volumes:
  postgres:
```

**Note:** the `target:` build args (`orderbook`, `autopilot`, `driver`, `solvers`, `migrations`) must match named build stages in upstream's `apps/backend/Dockerfile`. Verify by `grep '^FROM' apps/backend/Dockerfile`. If targets are different (e.g., upstream renames "solvers" to "solver-binaries"), update this compose accordingly. Do not change upstream — change ours.

- [ ] **Step 4: Verify upstream Dockerfile targets**

```bash
cd /Users/scep/greg
grep -E '^FROM .* AS ' apps/backend/Dockerfile
```
List the named stages. Update `target:` keys in the compose to match the stage names you see.

- [ ] **Step 5: Commit**

```bash
git add infra/local/
git commit -m "infra(local): stage-1 fork-mode compose + config templates from upstream playground"
git push
```

---

## Task 4: Boot the Stage-1 stack (forked Gnosis)

**Files:** none modified. This task validates the compose works.

- [ ] **Step 1: Populate `infra/local/.env`**

Copy from the example, leave forked-mode defaults:

```bash
cd /Users/scep/greg
cp infra/local/.env.example infra/local/.env
# Edit: ensure FORK_RPC_URL is a Gnosis archive node (https://rpc.gnosischain.com works for fork)
```

For Stage 1 fork-mode, the driver submitter is Anvil's account[0]:
- address `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- private key `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

Set `DRIVER_SUBMITTER_PK` and `SOLVER_ACCOUNT_ADDRESS` accordingly in `infra/local/.env`.

- [ ] **Step 2: Build images**

```bash
cd /Users/scep/greg
docker-compose -f infra/local/docker-compose.fork.yml --env-file infra/local/.env build 2>&1 | tail -30
```
Expected: builds complete. Most likely failure modes:
- `target` mismatch → re-check Task 3 Step 4.
- Cargo build OOM in Docker (Rust services compile is memory-hungry) → bump Docker Desktop's memory to ≥ 8 GB and retry.

- [ ] **Step 3: Boot the stack**

```bash
docker-compose -f infra/local/docker-compose.fork.yml --env-file infra/local/.env up -d
docker-compose -f infra/local/docker-compose.fork.yml ps
```
Expected: 7 services running (`chain`, `db`, `migrations` exited 0, `orderbook`, `autopilot`, `driver`, `baseline`).

- [ ] **Step 4: Smoke-check the orderbook HTTP API**

```bash
curl -sS http://localhost:8080/api/v1/version
curl -sS http://localhost:8080/api/v1/version | grep -i version
```
Expected: returns a JSON object with `version`, `commit`, `network` (chainId 100 since it's a Gnosis fork).

- [ ] **Step 5: Tail logs and verify autopilot is auctioning**

```bash
docker-compose -f infra/local/docker-compose.fork.yml logs --tail=30 autopilot | head -30
docker-compose -f infra/local/docker-compose.fork.yml logs --tail=30 driver | head -30
```
Look for log lines like:
- autopilot: `Starting autopilot for chain 100`, `processing block N`
- driver: `Listening on 0.0.0.0:80`

If services are crash-looping, capture their logs and report **BLOCKED** with the relevant tail.

- [ ] **Step 6: No commit (validation-only task)**

---

## Task 5: Confirm autopilot ↔ driver wiring (forked stack)

**Files:** none modified.

- [ ] **Step 1: Check autopilot can reach driver**

```bash
docker-compose -f infra/local/docker-compose.fork.yml exec autopilot \
  curl -fsS http://driver/baseline/info 2>&1 | head -10 || \
docker-compose -f infra/local/docker-compose.fork.yml logs --tail=80 autopilot \
  | grep -iE 'driver|solver|auction' | tail -20
```
Look for autopilot lines naming the `baseline` driver and stating it has been registered.

- [ ] **Step 2: Confirm an empty auction is published**

```bash
docker-compose -f infra/local/docker-compose.fork.yml exec db \
  psql -U "$POSTGRES_USER" -d postgres -c "SELECT id, deadline, surplus_capturing_jit_order_owners FROM auctions ORDER BY id DESC LIMIT 5;"
```
(Get `$POSTGRES_USER` from your env file.) Expected: at least one auction row even with no orders, since autopilot publishes empty auctions every block.

- [ ] **Step 3: Sanity-check the driver's HTTP endpoint**

```bash
curl -fsS http://localhost:8081/baseline/info 2>&1 | head -10 || echo "driver not reachable from host"
```
Note: depending on the upstream driver's routing, the `/info` path may differ. If 404, check `apps/backend/crates/driver/src/infra/api/` for the actual endpoint names. The point of this step is to confirm the driver process is up and accepting HTTP.

- [ ] **Step 4: No commit (validation)**

---

## Task 6: Stage-1 e2e — settle a test swap on the fork

**Files:**
- Create: `docs/development/phase-1-validation.md` (Stage 1 section, append later in Stage 2).

- [ ] **Step 1: Use anvil's account[0] as the trader**

Account 0 (`0xf39Fd6…`) has 10000 ETH on the fork. We'll swap WETH → COW or similar Gnosis-bridged token. Pick a pair the upstream playground tests cover — see `apps/backend/crates/e2e/tests/` for reference pairs and amounts.

- [ ] **Step 2: Wrap some xDAI to wxDAI (Gnosis fork uses xDAI native)**

```bash
WXDAI=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d   # canonical wxDAI on Gnosis mainnet, same address on fork
ANVIL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RPC=http://localhost:8545

cast send --rpc-url "$RPC" --private-key "$ANVIL_PK" "$WXDAI" "deposit()" --value 1ether
cast call --rpc-url "$RPC" "$WXDAI" "balanceOf(address)(uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```
Expected: balance shows `1e18`.

- [ ] **Step 3: Approve GPv2VaultRelayer on Gnosis (same address on the fork)**

```bash
RELAYER=0xC92E8bdf79f0507f65a392b0ab4667716BFE0110
cast send --rpc-url "$RPC" --private-key "$ANVIL_PK" "$WXDAI" "approve(address,uint256)" \
  "$RELAYER" 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
```

- [ ] **Step 4: Get a quote from the local orderbook**

```bash
TRADER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
COW=0x177127622c4A00F3d409B75571e12cB3c8973d3c   # canonical COW on Gnosis mainnet
WXDAI=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d

curl -sS -X POST http://localhost:8080/api/v1/quote \
  -H "Content-Type: application/json" \
  -d "{
    \"sellToken\": \"$WXDAI\",
    \"buyToken\":  \"$COW\",
    \"from\":      \"$TRADER\",
    \"receiver\":  \"$TRADER\",
    \"sellAmountBeforeFee\": \"100000000000000000\",
    \"kind\": \"sell\",
    \"signingScheme\": \"eip712\",
    \"appData\": \"{}\",
    \"appDataHash\": \"0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d\"
  }" | python3 -m json.tool
```
Expected: a quote with `sellAmount`, `buyAmount`, `feeAmount`, `validTo`. If 4xx, capture the error message and check orderbook logs.

- [ ] **Step 5: Build EIP-712 typed data, sign, submit**

(Same recipe as Phase 0 validation, with chainId=100 + `verifyingContract` = Gnosis Settlement.)

```bash
GPV2_SETTLEMENT=0x9008D19f58AAbD9eD0D60971565AA8510560ab41
QUOTE=$(curl -sS -X POST http://localhost:8080/api/v1/quote ...)  # repeat from Step 4
SELL_AMOUNT=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['sellAmount'])")
BUY_AMOUNT=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['buyAmount'])")
VALID_TO=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['validTo'])")
APP_DATA_HASH=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['appDataHash'])")
BUY_FLOOR=$(python3 -c "print(int($BUY_AMOUNT * 0.95))")

cat > /tmp/greg-stage1-typed.json <<EOF
{
  "types": {
    "EIP712Domain": [
      {"name": "name", "type": "string"},
      {"name": "version", "type": "string"},
      {"name": "chainId", "type": "uint256"},
      {"name": "verifyingContract", "type": "address"}
    ],
    "Order": [
      {"name": "sellToken", "type": "address"},
      {"name": "buyToken", "type": "address"},
      {"name": "receiver", "type": "address"},
      {"name": "sellAmount", "type": "uint256"},
      {"name": "buyAmount", "type": "uint256"},
      {"name": "validTo", "type": "uint32"},
      {"name": "appData", "type": "bytes32"},
      {"name": "feeAmount", "type": "uint256"},
      {"name": "kind", "type": "string"},
      {"name": "partiallyFillable", "type": "bool"},
      {"name": "sellTokenBalance", "type": "string"},
      {"name": "buyTokenBalance", "type": "string"}
    ]
  },
  "primaryType": "Order",
  "domain": {
    "name": "Gnosis Protocol",
    "version": "v2",
    "chainId": 100,
    "verifyingContract": "$GPV2_SETTLEMENT"
  },
  "message": {
    "sellToken": "$WXDAI",
    "buyToken":  "$COW",
    "receiver":  "$TRADER",
    "sellAmount": "$SELL_AMOUNT",
    "buyAmount":  "$BUY_FLOOR",
    "validTo":    $VALID_TO,
    "appData":    "$APP_DATA_HASH",
    "feeAmount":  "0",
    "kind":       "sell",
    "partiallyFillable": true,
    "sellTokenBalance": "erc20",
    "buyTokenBalance":  "erc20"
  }
}
EOF

SIG=$(cast wallet sign --private-key "$ANVIL_PK" --data --from-file /tmp/greg-stage1-typed.json)
echo "$SIG"

ORDER_BODY=$(cat <<EOF
{
  "sellToken":"$WXDAI","buyToken":"$COW","receiver":"$TRADER","from":"$TRADER",
  "sellAmount":"$SELL_AMOUNT","buyAmount":"$BUY_FLOOR","validTo":$VALID_TO,
  "appData":"{}","appDataHash":"$APP_DATA_HASH","feeAmount":"0","kind":"sell",
  "partiallyFillable":true,"sellTokenBalance":"erc20","buyTokenBalance":"erc20",
  "signature":"$SIG","signingScheme":"eip712"
}
EOF
)
curl -sS -w "\n%{http_code}\n" -X POST http://localhost:8080/api/v1/orders \
  -H "Content-Type: application/json" -d "$ORDER_BODY"
```
Expected: HTTP 201 with the order UID. Capture the UID.

- [ ] **Step 6: Watch settlement on the fork**

```bash
ORDER_UID=<paste UID from Step 5>
for i in $(seq 1 20); do
  state=$(curl -sS "http://localhost:8080/api/v1/orders/$ORDER_UID" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('executedBuyAmount'))")
  echo "$(date +%H:%M:%S) $state"
  echo "$state" | grep -q fulfilled && break
  sleep 6
done
curl -sS "http://localhost:8080/api/v1/trades?orderUid=$ORDER_UID" | python3 -m json.tool
```
Expected: transitions to `fulfilled` within ~2 minutes; trade record contains a tx hash on the *fork* (anvil's chain).

If it doesn't fill: relax the buy floor to 80% and try with `partiallyFillable: true`. If still doesn't fill: capture autopilot + driver logs and report **DONE_WITH_CONCERNS** so we can debug before Stage 2.

- [ ] **Step 7: Append Stage-1 evidence to validation log**

```bash
cd /Users/scep/greg
mkdir -p docs/superpowers
cat > docs/development/phase-1-validation.md <<'EOF'
# Phase 1 — Validation Log

## Stage 1: Forked Gnosis (no real money)

Trader: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (anvil account[0])
Pair: wxDAI → COW, sell 0.1 wxDAI
Order UID: <UID from Step 5>
Settlement tx (on the anvil fork): <hash from Step 6 trades>
Stage 1 verdict: PASS / FAIL — <one-line>

EOF
git add docs/development/phase-1-validation.md
git commit -m "docs(phase-1): stage-1 validation evidence (forked Gnosis swap settled)"
git push
```

---

## Task 7: Real-Gnosis compose + config divergence

**Files:**
- Create: `infra/local/docker-compose.gnosis.yml`
- Modify: `infra/local/configs/orderbook.toml`, `autopilot.toml`, `driver.toml`, `baseline.toml` (point at real RPC)

- [ ] **Step 1: Copy `docker-compose.fork.yml` → `docker-compose.gnosis.yml`**

```bash
cd /Users/scep/greg
cp infra/local/docker-compose.fork.yml infra/local/docker-compose.gnosis.yml
```

- [ ] **Step 2: Edit `docker-compose.gnosis.yml`**

Remove the `chain` service entirely. Replace every `http://chain:8545` reference with `${ETH_RPC_URL}` (sourced from `infra/local/.env`'s `GNOSIS_RPC_URL`). Update the `depends_on` lists to drop `chain`.

After editing, the compose has these services only: `db`, `migrations`, `orderbook`, `autopilot`, `driver`, `baseline`. They all read `ETH_RPC_URL` from env.

- [ ] **Step 3: Edit configs to use Gnosis settlement contracts and chainId**

In each `infra/local/configs/*.toml`, find any references to mainnet (chainId 1) values — chain ID, settlement contract, vault relayer, native token wrapper — and change to Gnosis equivalents:

| Param | Mainnet | Gnosis |
|---|---|---|
| chainId | 1 | 100 |
| GPv2Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | same |
| GPv2VaultRelayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` | same |
| WrappedNative | WETH `0xC02a…` | wxDAI `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` |
| Native price token | WETH | wxDAI |

Read `apps/backend/crates/chain/` for the canonical Gnosis address book. The configs may already auto-detect chain from `chainId` — if so, only chainId needs changing.

- [ ] **Step 4: Generate a fresh driver-submitter EOA**

```bash
cast wallet new
```
Capture the address and private key. Save to macOS Keychain:

```bash
DRIVER_PK=<paste>
DRIVER_ADDR=<paste>
security add-generic-password -a "greg-driver-submitter" -s "greg-driver-submitter" -w "$DRIVER_PK" -U
```

Update `infra/local/.env`:
```
DRIVER_SUBMITTER_PK=<paste>
DRIVER_SUBMITTER_ADDRESS=<paste>
SOLVER_ACCOUNT_ADDRESS=<paste>     # same EOA
```

- [ ] **Step 5: Commit**

```bash
git add infra/local/docker-compose.gnosis.yml infra/local/configs/
git commit -m "infra(local): stage-2 real-Gnosis compose + Gnosis-targeted configs"
git push
```

Do NOT commit `infra/local/.env`.

---

## Task 8: RPC fallback transport

**Files:**
- Create: `infra/rpc/fallback.ts`
- Create: `infra/rpc/package.json`
- Create: `infra/rpc/tests/fallback.test.ts`

- [ ] **Step 1: Write the failing test**

`infra/rpc/tests/fallback.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { gnosisFallbackTransport } from '../src/fallback';

describe('gnosisFallbackTransport', () => {
  it('exposes a viem fallback() transport', () => {
    expect(typeof gnosisFallbackTransport).toBe('function');
    const tx = gnosisFallbackTransport({});
    expect(tx).toBeDefined();
    expect(tx.config?.name?.toLowerCase()).toContain('fallback');
  });

  it('lists all three providers (Alchemy, PublicNode, Ankr) in order', () => {
    const tx = gnosisFallbackTransport({});
    const inner = (tx as any).value?.transports || (tx as any).config?.transports || [];
    const urls = inner.map((t: any) => t.value?.url || t.config?.url || '').join(' ');
    expect(urls).toMatch(/alchemy/i);
    expect(urls).toMatch(/publicnode/i);
    expect(urls).toMatch(/ankr/i);
  });
});
```

- [ ] **Step 2: Write `infra/rpc/package.json`**

```json
{
  "name": "@greg/rpc",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/fallback.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Add `infra/rpc` to root pnpm workspace**

Edit `/Users/scep/greg/pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/backend"
  - "infra/rpc"
```

- [ ] **Step 4: Run failing test**

```bash
cd /Users/scep/greg
pnpm install
pnpm --filter @greg/rpc test
```
Expected: fails because `src/fallback.ts` does not exist.

- [ ] **Step 5: Implement `infra/rpc/src/fallback.ts`**

```typescript
import { fallback, http } from 'viem';

const ALCHEMY_KEY = process.env.ALCHEMY_GNOSIS_KEY ?? 'demo';

export const GNOSIS_RPC_URLS = [
  `https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  'https://gnosis.publicnode.com',
  'https://rpc.ankr.com/gnosis',
] as const;

export const gnosisFallbackTransport = (opts?: { rank?: boolean; retryCount?: number }) =>
  fallback(
    GNOSIS_RPC_URLS.map((url) => http(url, { retryCount: opts?.retryCount ?? 1 })),
    { rank: opts?.rank ?? false },
  );
```

`infra/rpc/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist" },
  "include": ["src/**/*", "tests/**/*"]
}
```

`infra/rpc/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } });
```

- [ ] **Step 6: Run tests, verify green**

```bash
pnpm --filter @greg/rpc test
```
Expected: 2 passing.

- [ ] **Step 7: Commit**

```bash
git add infra/rpc/ pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(rpc): @greg/rpc gnosis fallback transport (Alchemy → PublicNode → Ankr)"
git push
```

---

## Task 9: Fund the test wallet on Gnosis mainnet (manual)

**Files:** none modified.

This task is **manual**. The Ophis test wallet `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` needs ~5–10 xDAI on Gnosis mainnet (chainId 100). The driver-submitter EOA from Task 7 needs ~0.5 xDAI for gas.

- [ ] **Step 1: Confirm balances are zero**

```bash
GREG_RPC=https://gnosis.publicnode.com
TEST_ADDR=0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB
DRIVER_ADDR=$(grep DRIVER_SUBMITTER_ADDRESS /Users/scep/greg/infra/local/.env | cut -d= -f2)

cast balance --rpc-url "$GREG_RPC" "$TEST_ADDR" --ether
cast balance --rpc-url "$GREG_RPC" "$DRIVER_ADDR" --ether
```
Expected: both 0 (or very close).

- [ ] **Step 2: Source xDAI** (operator decides)

Options:
- Bridge xDAI from Polygon (existing Polymarket wallet has USDC; bridge USDC to Gnosis via [Hop](https://hop.exchange) or Across, swap to xDAI).
- Buy xDAI directly on a CEX that supports Gnosis withdrawals (Binance, Kraken).
- If a personal wallet already holds xDAI, transfer 5 xDAI to `0x412cbCCe…` and 0.5 xDAI to the driver address.

- [ ] **Step 3: Verify funded**

```bash
cast balance --rpc-url "$GREG_RPC" "$TEST_ADDR" --ether
cast balance --rpc-url "$GREG_RPC" "$DRIVER_ADDR" --ether
```
Expected: ≥ 5 on test wallet, ≥ 0.5 on driver. Stop and re-fund if not.

- [ ] **Step 4: No commit (operational)**

---

## Task 10: Stage-2 e2e — settle a real Gnosis-mainnet swap

**Files:**
- Append to: `docs/development/phase-1-validation.md`.

- [ ] **Step 1: Boot the Stage-2 stack**

```bash
cd /Users/scep/greg
docker-compose -f infra/local/docker-compose.gnosis.yml --env-file infra/local/.env up -d
docker-compose -f infra/local/docker-compose.gnosis.yml ps
```
Expected: 6 services running (no `chain` container; `db`, `migrations` exit 0, `orderbook`, `autopilot`, `driver`, `baseline` running).

- [ ] **Step 2: Smoke-check orderbook on real Gnosis**

```bash
curl -sS http://localhost:8080/api/v1/version | python3 -m json.tool
```
Expected: returns version info; `chainId` (or `network`) field reads `100`.

- [ ] **Step 3: Tail autopilot for a few blocks**

```bash
docker-compose -f infra/local/docker-compose.gnosis.yml logs --tail=40 autopilot
```
Expected: log entries showing block heights advancing in sync with public Gnosis RPC. If autopilot is stuck at block 0 or repeatedly errors, the RPC URL is likely wrong — fix `infra/local/.env` and restart.

- [ ] **Step 4: Wrap a small amount of xDAI on the test wallet**

```bash
TEST_PK=$(security find-generic-password -s greg-chiado-test -w)
TEST_ADDR=0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB
WXDAI=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d
RELAYER=0xC92E8bdf79f0507f65a392b0ab4667716BFE0110
RPC=https://gnosis.publicnode.com

cast send --rpc-url "$RPC" --private-key "$TEST_PK" "$WXDAI" "deposit()" --value 0.5ether
cast send --rpc-url "$RPC" --private-key "$TEST_PK" "$WXDAI" "approve(address,uint256)" \
  "$RELAYER" 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
```

- [ ] **Step 5: Quote, sign, submit (via Ophis's local orderbook)**

Identical to Task 6 Step 5 except:
- `chainId` in EIP-712 domain = `100` (Gnosis mainnet)
- POST URL is `http://localhost:8080/api/v1/orders` (Ophis's local orderbook, NOT `api.cow.fi`)
- `verifyingContract` = `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` (same as Stage 1)

```bash
TRADER=$TEST_ADDR
COW=0x177127622c4A00F3d409B75571e12cB3c8973d3c

# 1) quote
QUOTE=$(curl -sS -X POST http://localhost:8080/api/v1/quote \
  -H "Content-Type: application/json" \
  -d "{\"sellToken\":\"$WXDAI\",\"buyToken\":\"$COW\",\"from\":\"$TRADER\",\"receiver\":\"$TRADER\",\"sellAmountBeforeFee\":\"100000000000000000\",\"kind\":\"sell\",\"signingScheme\":\"eip712\",\"appData\":\"{}\",\"appDataHash\":\"0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d\"}")
echo "$QUOTE" | python3 -m json.tool

SELL=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['sellAmount'])")
BUY=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['buyAmount'])")
VALID=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['validTo'])")
APPHASH=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['quote']['appDataHash'])")
FLOOR=$(python3 -c "print(int($BUY * 0.95))")

# 2) typed data
cat > /tmp/greg-stage2-typed.json <<EOF
{ "types": {
    "EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
    "Order":[{"name":"sellToken","type":"address"},{"name":"buyToken","type":"address"},{"name":"receiver","type":"address"},{"name":"sellAmount","type":"uint256"},{"name":"buyAmount","type":"uint256"},{"name":"validTo","type":"uint32"},{"name":"appData","type":"bytes32"},{"name":"feeAmount","type":"uint256"},{"name":"kind","type":"string"},{"name":"partiallyFillable","type":"bool"},{"name":"sellTokenBalance","type":"string"},{"name":"buyTokenBalance","type":"string"}]
  },
  "primaryType":"Order",
  "domain":{"name":"Gnosis Protocol","version":"v2","chainId":100,"verifyingContract":"0x9008D19f58AAbD9eD0D60971565AA8510560ab41"},
  "message":{"sellToken":"$WXDAI","buyToken":"$COW","receiver":"$TRADER","sellAmount":"$SELL","buyAmount":"$FLOOR","validTo":$VALID,"appData":"$APPHASH","feeAmount":"0","kind":"sell","partiallyFillable":true,"sellTokenBalance":"erc20","buyTokenBalance":"erc20"}
}
EOF

# 3) sign
SIG=$(cast wallet sign --private-key "$TEST_PK" --data --from-file /tmp/greg-stage2-typed.json)
echo "Signature: $SIG"

# 4) submit
curl -sS -w "\n%{http_code}\n" -X POST http://localhost:8080/api/v1/orders \
  -H "Content-Type: application/json" \
  -d "{\"sellToken\":\"$WXDAI\",\"buyToken\":\"$COW\",\"receiver\":\"$TRADER\",\"from\":\"$TRADER\",\"sellAmount\":\"$SELL\",\"buyAmount\":\"$FLOOR\",\"validTo\":$VALID,\"appData\":\"{}\",\"appDataHash\":\"$APPHASH\",\"feeAmount\":\"0\",\"kind\":\"sell\",\"partiallyFillable\":true,\"sellTokenBalance\":\"erc20\",\"buyTokenBalance\":\"erc20\",\"signature\":\"$SIG\",\"signingScheme\":\"eip712\"}"
```
Expected: HTTP 201 with order UID. Capture it.

- [ ] **Step 6: Watch settlement on real Gnosis**

```bash
ORDER_UID=<paste>
for i in $(seq 1 60); do
  state=$(curl -sS "http://localhost:8080/api/v1/orders/$ORDER_UID" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('executedBuyAmount'))")
  echo "$(date +%H:%M:%S) $state"
  echo "$state" | grep -q fulfilled && break
  sleep 6
done
curl -sS "http://localhost:8080/api/v1/trades?orderUid=$ORDER_UID" | python3 -m json.tool
```
Expected: order transitions to `fulfilled`; trade record contains an on-chain Gnosis tx hash. Verify on https://gnosisscan.io/.

- [ ] **Step 7: Append Stage-2 evidence**

Edit `docs/development/phase-1-validation.md`, add a Stage-2 section with: order UID, settlement tx hash, gnosisscan link, time-to-settle, trader balance change.

- [ ] **Step 8: Commit**

```bash
git add docs/development/phase-1-validation.md
git commit -m "docs(phase-1): stage-2 validation — real Gnosis-mainnet swap settled via Ophis orderbook"
git push
```

---

## Task 11: Phase 1 close-out

**Files:**
- Modify: `infra/local/README.md` (fill in operational sections)
- Create: `docs/development/status/<today>.md` (Phase 1 status sweep)

- [ ] **Step 1: Flesh out the README**

Open `infra/local/README.md` and add sections that were placeholders in Task 1:
- **Boot order** (Stage 1): `cp .env.example .env && docker-compose -f docker-compose.fork.yml --env-file .env up -d`
- **Boot order** (Stage 2): `docker-compose -f docker-compose.gnosis.yml --env-file .env up -d`
- **Smoke test commands** (curl orderbook, check autopilot logs)
- **Teardown**: `docker-compose -f <compose> down --volumes`
- **Troubleshooting**: list the 3-5 most likely failures from Tasks 4 / 5 / 10 with their fixes

- [ ] **Step 2: Open a Phase-2 tracking issue**

```bash
gh issue create --repo ophis-fi/ophis \
  --title "Phase 2: cloud deploy + E features" \
  --body "Tracking issue for Phase 2: deploy the Phase-1 stack to Aleph + Supabase + Grafana, repoint frontend at the deployed orderbook URL, add CI jobs for FE and BE, and ship the E features (DCA / TWAP, Safe app, MEV-proof receipts, PWA polish).

Predecessor plan: docs/development/plans/2026-05-02-ophis-phase-1-local-self-hosted-stack.md
Predecessor tag: v0.1-phase1
"
```

- [ ] **Step 3: Tag**

```bash
git tag -a v0.1-phase1 -m "Phase 1 local self-hosted stack complete — settled real Gnosis-mainnet swap via Ophis orderbook"
git push --tags
```

- [ ] **Step 4: Status sweep**

Dispatch the `pm` agent (per `agents/pm.md`) to write `docs/development/status/<today>.md` summarising:
- All 11 task outcomes
- Stage 1 + Stage 2 phase-gate evidence (with order UIDs and tx hashes)
- Open follow-ups for Phase 2 (cloud deploy, observability, CI jobs)
- Deviations from the plan with rationale

- [ ] **Step 5: Commit**

```bash
git add infra/local/README.md docs/development/status/
git commit -m "docs: phase-1 close-out (runbook + status sweep)"
git push
```

---

## Self-Review Notes

**Spec coverage**
- Self-hosted orderbook: Tasks 1–4 (Postgres + boot orderbook).
- Self-hosted autopilot + driver + solver: Tasks 3–5.
- Postgres on Supabase: **NOT in this plan** — Phase 2 deliverable. Phase 1 uses local Postgres in Docker. The spec didn't require Supabase as part of Phase 1's *correctness* gate; it required it as part of *production hosting*, which is Phase 2.
- RPC fallback: Task 8 (`@greg/rpc`).
- Frontend repointed: **NOT in this plan** — repointing to *localhost:8080* without a stable address is awkward. Phase 2 (cloud deploy) gives us a real URL to repoint to. Phase 1 still validates the FE→our-orderbook integration via `apps/frontend/.env.development.local.example` doc, but doesn't make the prod build use it.
- Real Gnosis-mainnet swap as the gate: Tasks 9–10.
- Aleph deploy: explicitly Phase 2.

**Placeholders:** none. The few `<paste from previous step>` markers are runtime values unique to each run, not author placeholders.

**Type / name consistency:** `gnosisFallbackTransport`, `GNOSIS_RPC_URLS` defined and used in Task 8 only — no consumers in this plan, so no inconsistency risk yet (consumers come in Phase 2 cloud deploy).

**Risk:** Tasks 3–4 contain "read upstream Dockerfile, identify build targets" steps because the upstream playground compose isn't 1:1 reproducible without seeing the actual stage names. This is correct — the plan can't bake in details the engineer must verify.

**Out of scope (to prevent drift):**
- No new Solidity. No protocol-level fee router. No partner-fee routing. No KYC.
- No mobile / PWA changes. No Safe app. No DCA UI. (All Phase 2.)
- No Aleph deploy, no Supabase, no Grafana. (All Phase 2.)
- No CI updates for the BE/FE jobs that were deferred in Phase 0. (Phase 2.)
