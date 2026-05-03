# Greg Phase 3 — MegaETH Fork-Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy CoW Protocol's audited `GPv2Settlement` + `GPv2VaultRelayer` bytecode unchanged on MegaETH (chainId `4326`), under our own `GPv2AllowListAuthentication` we control. Wire the vendored `apps/backend/` Rust services (orderbook + autopilot + driver + baseline solver) as the production runtime against our own settlement contracts. Greg becomes the chain-native intent broker on a chain CoW has not deployed to. First swap on MegaETH settles end-to-end via Greg's stack.

**Architecture:** **Two stages.** Stage 1 (Tasks 1-7) deploys + validates everything on MegaETH **testnet** (chainId `6342`, RPC `https://carrot.megaeth.com/rpc`) — zero-money risk. Stage 2 (Tasks 8-10) re-runs the same flow on MegaETH **mainnet** (chainId `4326`) once testnet is green. The settlement contracts are deployed unchanged from the cowprotocol/contracts source — we inherit Trail of Bits / Gnosis / G0 audit coverage. Our only customisation is the `GPv2AllowListAuthentication` deployment with our manager EOA in control of the solver allowlist (so our own driver-submitter is allowed to call `settle()`).

**Tech Stack:** Solidity (cowprotocol/contracts source), Hardhat (their build system), Foundry `cast` for deployment + tx ops, the existing Rust services workspace at `apps/backend/`, Docker + Colima (existing Phase-1 pattern), MegaETH testnet + mainnet RPCs, MegaETH explorer (`https://megaexplorer.xyz` for testnet; mainnet explorer to be confirmed at deploy time).

**Spec:** [`docs/superpowers/specs/2026-05-02-greg-design.md`](../specs/2026-05-02-greg-design.md) + [`docs/superpowers/specs/2026-05-03-greg-design-amendment.md`](../specs/2026-05-03-greg-design-amendment.md).

**Predecessor plan:** [`docs/superpowers/plans/2026-05-02-greg-phase-1-local-self-hosted-stack.md`](2026-05-02-greg-phase-1-local-self-hosted-stack.md) — the vendored `apps/backend/` services stack from Phase 1 is the production runtime here.

**Phase gate (Stage 2 — the real one):** A small swap on MegaETH **mainnet** (chainId `4326`) using our test wallet settles via Greg's own deployed `GPv2Settlement`. Trade record visible on MegaETH's explorer. Validation log committed.

---

## Operator decisions to lock BEFORE execution

| # | Decision | Default if undecided |
|---|---|---|
| **D1** | Deployer EOA — fresh wallet vs reuse Phase-1 driver-submitter `0x00f98b…502F` | **Generate a fresh dedicated EOA** (`greg-megaeth-deployer` Keychain entry). Cleaner audit trail; deployer has admin rights on the auth contract until Phase 3.x transfers to a Safe. |
| **D2** | Settlement-contract authority (initial owner of `GPv2AllowListAuthentication`) | **Same EOA as D1** for Stage 1 testnet (low value, easy to manage). For mainnet, transfer ownership to the existing Phase-2.5 Gnosis Safe `0x858f0F5e…CeF8` after deploy. |
| **D3** | Driver-submitter EOA on MegaETH (the EOA that signs settle() txs) | **Reuse Phase-1 driver-submitter** `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` (Keychain `greg-driver-submitter`). Lazy-fund on MegaETH testnet, then mainnet. The auth contract's `addSolver(...)` call adds it to our allowlist. |
| **D4** | MegaETH foundation grant application | **DEFERRED** (Clement 2026-05-04) — only apply once production is fully live: real domain, real brand, app validated by real users, contracts deployed and stable. Task 11 keeps the **draft template** in the plan so we don't lose context, but submission moves to Phase 4+ once "production-ready" is true. |

---

## File Structure (created or modified by this plan)

| Path | Action | Purpose |
|---|---|---|
| `contracts/` | Create (subtree) | `cowprotocol/contracts` vendored as a git subtree |
| `contracts/.greg-upstream` | Create | Pinned upstream commit SHA |
| `infra/megaeth/.env.example` | Create | RPC URLs + addresses + deployer keys (gitignored .env) |
| `infra/megaeth/deploy/networks.ts` | Create | Hardhat network config for testnet (6342) + mainnet (4326) |
| `infra/megaeth/deploy/run-deploy.sh` | Create | Operator runbook for deploying contracts on a target network |
| `infra/megaeth/configs/orderbook.toml` | Create | Greg orderbook config for MegaETH |
| `infra/megaeth/configs/autopilot.toml` | Create | autopilot config — references our deployed Settlement + AllowListAuth + driver |
| `infra/megaeth/configs/driver.toml` | Create | driver config — Settlement + VaultRelayer + DEX presets for MegaETH |
| `infra/megaeth/configs/baseline.toml` | Create | baseline solver config — chain-id 4326/6342, MegaETH base tokens |
| `infra/megaeth/docker-compose.testnet.yml` | Create | Stage-1 stack (no anvil; real testnet RPC) |
| `infra/megaeth/docker-compose.mainnet.yml` | Create | Stage-2 stack |
| `infra/megaeth/README.md` | Create | Operator runbook |
| `docs/superpowers/phase-3-validation.md` | Create | Phase-gate evidence (Stage 1 + Stage 2) |
| `docs/superpowers/megaeth-grant-application.md` | Create | Grant application draft (Task 11) |

**Not modified:** `apps/frontend/`, `apps/backend/` (vendored upstream — read-only), `packages/`, the partner-fee atom, the mevReceipt module. Phase 3 leaves the existing CoW-chain product untouched; MegaETH is additive.

---

## Dispatch hints

- **Tasks 1-2:** main session (CTO) — wallet generation + git subtree mechanics.
- **Tasks 3-5:** `backend` agent — Solidity build + deploy on testnet (Stage 1).
- **Task 6:** `backend` agent — services config for testnet.
- **Task 7:** main session — Stage-1 e2e (programmatic, like Phase 1.5).
- **Tasks 8-10:** mix — Stage 2 mainnet deploy + e2e (operator hands needed for funding mainnet wallets).
- **Task 11:** main session — grant application draft.
- **Task 12:** main session — close-out + tag.

---

## Task 1: Generate MegaETH deployer EOA + capture addresses for the plan

**Files:**
- Modify: `infra/megaeth/.env.example` (created in Step 5; documents the addresses)

### Step 1: Generate the deployer keypair

```bash
cast wallet new
```

Capture `Address:` and `Private key:` from stdout.

### Step 2: Save private key to macOS Keychain

```bash
DEPLOYER_PK=<paste private key from Step 1>
DEPLOYER_ADDR=<paste address from Step 1>
security add-generic-password \
  -a "greg-megaeth-deployer" \
  -s "greg-megaeth-deployer" \
  -w "$DEPLOYER_PK" -U
security find-generic-password -a "greg-megaeth-deployer" -s "greg-megaeth-deployer" -w | head -c 5
```
Expected: prints `0x` + 3 hex chars (sanity check).

### Step 3: Verify deployer address derives from keychain readback

```bash
RETRIEVED_PK=$(security find-generic-password -a "greg-megaeth-deployer" -s "greg-megaeth-deployer" -w)
DERIVED_ADDR=$(cast wallet address "$RETRIEVED_PK")
echo "Derived: $DERIVED_ADDR"
echo "Expected: $DEPLOYER_ADDR"
```
Expected: case-insensitive match.

### Step 4: Document the addresses

Capture for the plan-author / next tasks:

- Deployer EOA address: `<DEPLOYER_ADDR>`
- Driver-submitter EOA (reused from Phase 1): `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F`
- Manager-eventual address (Phase 3.x transfer target): existing Gnosis Safe `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` (CREATE2-deterministic — also resolves on MegaETH; deploy proxy lazily before transferring ownership).

### Step 5: Create `infra/megaeth/.env.example`

```bash
mkdir -p /Users/scep/greg/infra/megaeth
```

Write `/Users/scep/greg/infra/megaeth/.env.example`:

```ini
# infra/megaeth/.env — Greg Phase 3 MegaETH deploy environment
# Copy to infra/megaeth/.env and fill in. NEVER commit infra/megaeth/.env.
# ---------------------------------------------------------------

# --- Networks ---
MEGAETH_TESTNET_RPC=https://carrot.megaeth.com/rpc
MEGAETH_TESTNET_CHAIN_ID=6342
MEGAETH_TESTNET_EXPLORER=https://megaexplorer.xyz

# Mainnet RPC + explorer to be confirmed at Stage-2 start (megaeth.com / chainlist.org).
MEGAETH_MAINNET_RPC=
MEGAETH_MAINNET_CHAIN_ID=4326
MEGAETH_MAINNET_EXPLORER=

# --- Deployer EOA (Greg) ---
# Private key in macOS Keychain entry `greg-megaeth-deployer`.
GREG_MEGAETH_DEPLOYER_ADDRESS=<DEPLOYER_ADDR from Step 4>

# --- Driver submitter (reuse Phase 1) ---
# Private key in macOS Keychain entry `greg-driver-submitter`.
GREG_DRIVER_SUBMITTER_ADDRESS=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F

# --- Greg-deployed contract addresses (filled after Tasks 4-5) ---
GREG_AUTH_TESTNET=
GREG_SETTLEMENT_TESTNET=
GREG_VAULT_RELAYER_TESTNET=
GREG_AUTH_MAINNET=
GREG_SETTLEMENT_MAINNET=
GREG_VAULT_RELAYER_MAINNET=

# --- Partner-fee recipient (unchanged from Phase 2.5) ---
# Gnosis Safe; CREATE2-deterministic; same address on MegaETH after lazy proxy deploy.
GREG_PARTNER_FEE_RECIPIENT=0x858f0F5eE954846D47155F5203c04aF1819eCeF8
```

Replace `<DEPLOYER_ADDR from Step 4>` with the actual address. Do NOT include the private key in this file.

### Step 6: Create `infra/megaeth/.gitignore`

```bash
echo -e ".env\n*.log\n" > /Users/scep/greg/infra/megaeth/.gitignore
git check-ignore /Users/scep/greg/infra/megaeth/.env >/dev/null && echo "✓ .env ignored"
```

### Step 7: Commit

```bash
cd /Users/scep/greg
git add infra/megaeth/
git status
git commit -m "infra(megaeth): scaffold deploy environment + deployer EOA address recorded"
git push
```

The actual `.env` (with the private key) does NOT exist as a file (key is in Keychain only). Only `.env.example` is committed.

## Task 2: Vendor `cowprotocol/contracts` as a git subtree at `contracts/`

**Files:**
- Create: `contracts/` (subtree)
- Create: `contracts/.greg-upstream` (pinned SHA)

We need the Solidity source for `GPv2Settlement` + `GPv2VaultRelayer` + `GPv2AllowListAuthentication`. Vendor `cowprotocol/contracts` the same way Phase 0 vendored `cowprotocol/cowswap` and `cowprotocol/services`.

### Step 1: Add upstream remote

```bash
cd /Users/scep/greg
git remote add contracts-upstream https://github.com/cowprotocol/contracts.git
git fetch contracts-upstream main
git remote -v
```

### Step 2: Subtree-add

```bash
git subtree add --prefix=contracts contracts-upstream main --squash
```

### Step 3: Pin upstream SHA

```bash
git log -1 contracts-upstream/main --format='%H %s' > contracts/.greg-upstream
cat contracts/.greg-upstream
git add contracts/.greg-upstream
git commit -m "chore(contracts): pin upstream cowprotocol/contracts commit"
git push
```

### Step 4: Sanity-check the subtree

```bash
ls contracts/
test -f contracts/package.json && echo "✓ package.json"
test -f contracts/hardhat.config.ts && echo "✓ hardhat.config.ts"
ls contracts/src/contracts/ 2>/dev/null | head -5
```
Expected: hardhat-based repo with `src/contracts/` directory containing `GPv2Settlement.sol`, `GPv2VaultRelayer.sol`, `GPv2AllowListAuthentication.sol`.

## Task 3: Build `cowprotocol/contracts` locally

**Files:**
- Create: `contracts/.greg-build-notes.md`

### Step 1: Read the upstream README

```bash
cd /Users/scep/greg/contracts
head -100 README.md
cat package.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('name:', d.get('name'))
print('packageManager:', d.get('packageManager','(none)'))
print('scripts:', list(d.get('scripts', {}).keys())[:10])
print('hardhat in deps:', 'hardhat' in (d.get('devDependencies', {}) | d.get('dependencies', {})))
"
```

### Step 2: Install deps

```bash
cd /Users/scep/greg/contracts
# Pick whichever package manager the repo uses (yarn or npm — verify from package.json's packageManager field):
# If yarn classic:  yarn install
# If yarn berry:    corepack enable && yarn install --immutable
# If npm:           npm ci
yarn install 2>&1 | tail -5
```
If yarn is the wrong tool, fall back to whichever package manager `package.json` specifies. Document the actual choice in build notes.

### Step 3: Compile

```bash
cd /Users/scep/greg/contracts
yarn build 2>&1 | tail -10  # or `yarn compile`, `npx hardhat compile`
```
Expected: artifacts produced at `contracts/build/artifacts/` or `contracts/artifacts/`. No solc errors.

### Step 4: Document the build path

Write `/Users/scep/greg/contracts/.greg-build-notes.md`:

```markdown
# contracts/ build notes

Upstream: cowprotocol/contracts (see `.greg-upstream` for pinned SHA).
Package manager: <yarn | npm — confirm from package.json>.
Build: `<exact command from Step 3>`.
Artifacts directory: `<exact path>`.

Required Node version: <from .nvmrc or engines field>.
```

### Step 5: Commit

```bash
cd /Users/scep/greg
git add contracts/.greg-build-notes.md
git commit -m "build(contracts): document local build path"
git push
```

Don't commit `node_modules/` or build artifacts (they should be in upstream's .gitignore which subtree honors).

## Task 4: Adapt deploy scripts for MegaETH testnet

**Files:**
- Modify: `contracts/hardhat.config.ts` (or create `infra/megaeth/deploy/hardhat-megaeth.config.ts`)
- Create: `infra/megaeth/deploy/run-deploy.sh`

The cowprotocol/contracts repo ships a Hardhat deploy script that handles the deploy order (auth → settlement → vault relayer). We add a MegaETH network entry and call the same script.

### Step 1: Inspect the existing deploy script + network configs

```bash
cd /Users/scep/greg/contracts
cat hardhat.config.ts | grep -A30 'networks'
ls deploy/ 2>/dev/null
ls scripts/ 2>/dev/null
grep -RIn 'GPv2AllowListAuthentication\|deploy\.script' deploy/ scripts/ src/ 2>/dev/null | head -10
```

The deploy script is typically at `deploy/<index>_<name>.ts`. Read it.

### Step 2: Choose between modifying upstream or layering our own config

**Default: layer.** Modifying `hardhat.config.ts` directly creates a tracked-divergence on `git subtree pull`. Cleaner: create a Greg-specific config that imports + extends the upstream, lives in `infra/megaeth/deploy/`.

Write `/Users/scep/greg/infra/megaeth/deploy/hardhat-megaeth.config.ts`:

```typescript
import { HardhatUserConfig } from 'hardhat/config'
import baseConfig from '../../../contracts/hardhat.config'

const MEGAETH_TESTNET_RPC = process.env.MEGAETH_TESTNET_RPC ?? 'https://carrot.megaeth.com/rpc'
const MEGAETH_MAINNET_RPC = process.env.MEGAETH_MAINNET_RPC ?? ''
const DEPLOYER_PK = process.env.GREG_MEGAETH_DEPLOYER_PK ?? ''

const config: HardhatUserConfig = {
  ...baseConfig,
  networks: {
    ...baseConfig.networks,
    'megaeth-testnet': {
      url: MEGAETH_TESTNET_RPC,
      chainId: 6342,
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
    },
    'megaeth-mainnet': {
      url: MEGAETH_MAINNET_RPC,
      chainId: 4326,
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
    },
  },
}

export default config
```

The `baseConfig` import path may need adjustment depending on how upstream exports it (default export vs named). Inspect `contracts/hardhat.config.ts` to confirm.

### Step 3: Write the operator deploy runbook

`/Users/scep/greg/infra/megaeth/deploy/run-deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./run-deploy.sh megaeth-testnet
# Or:    ./run-deploy.sh megaeth-mainnet
NETWORK="${1:?network arg required (megaeth-testnet | megaeth-mainnet)}"

# Source env (RPCs)
set -a
source /Users/scep/greg/infra/megaeth/.env
set +a

# Read deployer PK from Keychain into env (do NOT commit anywhere)
export GREG_MEGAETH_DEPLOYER_PK=$(security find-generic-password \
  -a "greg-megaeth-deployer" -s "greg-megaeth-deployer" -w)

# Run hardhat deploy with our config
cd /Users/scep/greg/contracts
HARDHAT_CONFIG=../infra/megaeth/deploy/hardhat-megaeth.config.ts \
  npx hardhat deploy --network "$NETWORK" 2>&1 | tee \
  "/Users/scep/greg/infra/megaeth/deploy-log-${NETWORK}-$(date +%Y%m%d-%H%M%S).log"

echo ""
echo "=== capture the deployed addresses from the log above and add to infra/megaeth/.env ==="
echo "=== fields: GREG_AUTH_${NETWORK}_UPPER, GREG_SETTLEMENT_${NETWORK}_UPPER, GREG_VAULT_RELAYER_${NETWORK}_UPPER ==="
```

```bash
chmod +x /Users/scep/greg/infra/megaeth/deploy/run-deploy.sh
```

### Step 4: Commit

```bash
cd /Users/scep/greg
git add infra/megaeth/deploy/
git status
git commit -m "infra(megaeth): hardhat config layered for testnet + mainnet; deploy runbook"
git push
```

## Task 5: Deploy contracts on MegaETH testnet (Stage 1)

**Files:**
- Modify: `infra/megaeth/.env` (gitignored — fills in deployed addresses)

### Step 1: Fund deployer EOA on MegaETH testnet

Visit a MegaETH testnet faucet (`https://testnet.megaeth.com` lists faucets) and request testnet ETH for the deployer address. Need ~0.5 testnet ETH for safe contract deploys.

```bash
DEPLOYER_ADDR=$(grep GREG_MEGAETH_DEPLOYER_ADDRESS /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
RPC=https://carrot.megaeth.com/rpc
cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether
```
Expected: ≥ 0.1 ETH after the faucet drip (faucet typically gives 0.05-1 ETH).

If the testnet faucet is hard to find, try:
- https://testnet.megaeth.com (official portal)
- https://faucet.megaeth.com
- https://thirdweb.com/megaeth-testnet (lists current faucets)
- Public Discord channels announce drip windows

### Step 2: Run the deploy

```bash
cd /Users/scep/greg/infra/megaeth/deploy
./run-deploy.sh megaeth-testnet
```

Watch the log. Expect three transactions:
1. Deploy `GPv2AllowListAuthentication` — capture address
2. Initialize Authentication with manager EOA (the deployer initially)
3. Deploy `GPv2Settlement` (which deploys `GPv2VaultRelayer` in its constructor) — capture both addresses

If the upstream deploy script does anything different, follow the actual output. The captures we need are three addresses.

### Step 3: Capture deployed addresses

Edit `/Users/scep/greg/infra/megaeth/.env` (gitignored):

```ini
GREG_AUTH_TESTNET=0x<address>
GREG_SETTLEMENT_TESTNET=0x<address>
GREG_VAULT_RELAYER_TESTNET=0x<address>
```

### Step 4: Sanity-check on the explorer

Visit `https://megaexplorer.xyz/address/<settlement address>`. Expect: contract source verified (or unverified — verification is a follow-up Phase 3.x task), code present, deployment tx visible.

### Step 5: Add our driver-submitter to the allowlist

```bash
DEPLOYER_PK=$(security find-generic-password -a "greg-megaeth-deployer" -s "greg-megaeth-deployer" -w)
RPC=https://carrot.megaeth.com/rpc
AUTH=$(grep GREG_AUTH_TESTNET /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
DRIVER=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F

# Authentication contract has addSolver(address) restricted to manager
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" "$AUTH" \
  "addSolver(address)" "$DRIVER" 2>&1 | tail -10
```

If `addSolver` is the wrong function name (some versions use `setSolver`, `grant`, etc.), inspect the auth contract source: `cat /Users/scep/greg/contracts/src/contracts/GPv2AllowListAuthentication.sol`.

Verify:
```bash
cast call --rpc-url "$RPC" "$AUTH" "isSolver(address)(bool)" "$DRIVER"
```
Expected: `true`.

### Step 6: No commit (operational state — addresses live in .env which is gitignored; record the deploy log file path in the validation log later)

## Task 6: Adapt `infra/megaeth/configs/` for testnet

**Files:**
- Create: `infra/megaeth/configs/{orderbook,autopilot,driver,baseline}.toml`

### Step 1: Copy Phase-1 Gnosis configs as starting points

```bash
cd /Users/scep/greg
mkdir -p infra/megaeth/configs
cp infra/local/configs/orderbook.toml infra/megaeth/configs/orderbook.toml
cp infra/local/configs/autopilot.toml infra/megaeth/configs/autopilot.toml
cp infra/local/configs/driver.toml    infra/megaeth/configs/driver.toml
cp infra/local/configs/baseline.toml  infra/megaeth/configs/baseline.toml
```

### Step 2: Edit `baseline.toml` for MegaETH testnet

- `chain-id = "100"` → `chain-id = "6342"` (testnet first; mainnet swap is Stage 2)
- Replace `base-tokens` with MegaETH testnet equivalents. Standard set:
  ```toml
  base-tokens = [
      "<WETH on MegaETH testnet>",
      "<USDC on MegaETH testnet>",
  ]
  ```
  Look up these addresses by:
  - Checking `https://megaexplorer.xyz` for the WETH9 deploy
  - Checking the official MegaETH docs at `https://docs.megaeth.com`
  - Querying via cast: `cast call --rpc-url $RPC <factory> "getPair(...)"` to discover canonical pairs
- `weth = "<MegaETH testnet WETH>"` (or whichever native-wrapper field name baseline.toml uses)

### Step 3: Edit `driver.toml`

- `chain-id` → `"6342"`
- Replace Greg's deployed Settlement address: any field referencing `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` → `$GREG_SETTLEMENT_TESTNET` (read from .env at runtime via env-var substitution; the upstream config supports `%VAR_NAME` placeholders for some fields).
- Replace VaultRelayer reference if present: `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` → `$GREG_VAULT_RELAYER_TESTNET`.
- DEX presets: drop Honeyswap (Gnosis-only); add Uniswap V3 if deployed on MegaETH (factory deterministic address `0x1F98431c8aD98523631AE4a59f267346ea31F984` may or may not exist on MegaETH — verify with `cast code <factory>` against the testnet RPC). Add native MegaETH DEXes via inspection of `https://docs.megaeth.com` or `https://www.coingecko.com/en/exchanges/decentralized/megaeth`.

If no V3 deployment is verified at deploy time, fall back to Uniswap V2-style preset pointed at any mainnet-style V2 router that's been deployed on MegaETH testnet.

If NO DEX-with-liquidity is found on testnet, the swap won't have anything to route through. In that case, deploy a small WETH/USDC pool on Uniswap V3 at the testnet (~$10 of testnet ETH) to have something to swap against. Document this as a deviation.

### Step 4: Edit `orderbook.toml`

- chain-id → `"6342"`
- ETH RPC URL pinned to `https://carrot.megaeth.com/rpc` (or use env-var substitution if the orderbook config supports it; otherwise hardcode for testnet — Stage 2 will fork the file for mainnet)
- WETH address → MegaETH-testnet WETH

### Step 5: Edit `autopilot.toml`

- `[[drivers]]` block: ensure the driver address matches our driver-submitter `0x00f98b…502F` AND the driver URL points at our driver service.
- chain-id → `"6342"`
- Settlement contract → Greg's deployed `GREG_SETTLEMENT_TESTNET`.

### Step 6: Commit

```bash
cd /Users/scep/greg
git add infra/megaeth/configs/
git status
git commit -m "infra(megaeth): testnet configs — chain-id 6342, our deployed contracts, MegaETH DEX presets"
git push
```

## Task 7: Stage-1 e2e — first swap on MegaETH testnet

**Files:**
- Create: `infra/megaeth/docker-compose.testnet.yml`
- Append to: `docs/superpowers/phase-3-validation.md` (Stage 1 section, file created at the end of Task 12)

### Step 1: Write `docker-compose.testnet.yml`

Copy the structure from `infra/local/docker-compose.gnosis.yml` (Phase 1 Stage 2 — the production-shape compose with no anvil). Adjust:

- Volume mounts → `./configs/orderbook.toml`, `./configs/autopilot.toml`, etc.
- ETH_RPC_URL → `${MEGAETH_TESTNET_RPC}`
- Drop any chain container references (we point at real testnet RPC).
- All other services (db, migrations, orderbook, autopilot, driver, baseline) — same as Phase 1 Stage 2.

```bash
cd /Users/scep/greg
cp infra/local/docker-compose.gnosis.yml infra/megaeth/docker-compose.testnet.yml
# Edit the new file: replace ./configs/ with ./configs/ (relative paths still work since the compose lives in infra/megaeth/), replace GNOSIS_RPC_URL with MEGAETH_TESTNET_RPC, etc.
```

Verify it parses:
```bash
docker compose -f infra/megaeth/docker-compose.testnet.yml --env-file infra/megaeth/.env config 2>&1 | head -20
```

### Step 2: Boot the stack

```bash
cd /Users/scep/greg
docker compose -f infra/megaeth/docker-compose.testnet.yml --env-file infra/megaeth/.env up -d
sleep 30
docker compose -f infra/megaeth/docker-compose.testnet.yml ps
```
Expected: 6 services (db, migrations exited 0, orderbook, autopilot, driver, baseline) running.

### Step 3: Smoke-check

```bash
curl -fsS http://localhost:8080/api/v1/version | python3 -m json.tool
docker compose -f infra/megaeth/docker-compose.testnet.yml logs --tail=30 autopilot 2>&1 | head -40
```
Expected: orderbook responds; autopilot processes MegaETH testnet blocks (~10ms cadence — VERY fast vs Gnosis's 12s).

### Step 4: Fund test wallet on MegaETH testnet

The Phase-0 test wallet `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` (Keychain `greg-chiado-test`) — fund via the MegaETH testnet faucet with ~0.05 testnet ETH.

```bash
TEST_ADDR=0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB
RPC=https://carrot.megaeth.com/rpc
cast balance --rpc-url "$RPC" "$TEST_ADDR" --ether
```

### Step 5: Wrap testnet ETH → WETH, approve our VaultRelayer

```bash
TEST_PK=$(security find-generic-password -s greg-chiado-test -w)
WETH=<MegaETH testnet WETH address from Task 6 Step 2>
RELAYER=$(grep GREG_VAULT_RELAYER_TESTNET /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
RPC=https://carrot.megaeth.com/rpc

cast send --rpc-url "$RPC" --private-key "$TEST_PK" "$WETH" "deposit()" --value 0.01ether
cast send --rpc-url "$RPC" --private-key "$TEST_PK" "$WETH" \
  "approve(address,uint256)" "$RELAYER" \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
```

### Step 6: Quote → sign → submit (replicate Phase-1.5 / Phase-2 e2e pattern)

Same recipe as `/tmp/greg-part-b.sh` from Phase 1.5 validation, with MegaETH chainId + our Settlement address in the EIP-712 domain:

```typescript
domain: {
  name: 'Gnosis Protocol',
  version: 'v2',
  chainId: 6342,
  verifyingContract: <GREG_SETTLEMENT_TESTNET from .env>
}
```

The orderbook URL is `http://localhost:8080/api/v1/orders` (our own orderbook, not `api.cow.fi`).

If the quote endpoint returns NoLiquidity, the baseline solver couldn't find any DEX. Surface it as DONE_WITH_CONCERNS — Task 6 may need a Uniswap V3 pool seeded.

### Step 7: Watch settlement

```bash
ORDER_UID=<paste from Step 6>
for i in $(seq 1 60); do
  state=$(curl -sS "http://localhost:8080/api/v1/orders/$ORDER_UID" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('executedBuyAmount','0'))")
  echo "[$(date +%H:%M:%S)] $state"
  echo "$state" | grep -qE 'fulfilled|cancelled|expired' && break
  sleep 6
done
```

If fulfilled: capture tx hash from `curl /api/v1/trades?orderUid=...`. Verify on `https://megaexplorer.xyz/tx/<hash>`.

### Step 8: Capture Stage-1 evidence

Append to a temp file `/tmp/greg-phase3-stage1.md` for inclusion in the final validation log:

```markdown
## Stage 1: MegaETH testnet (chainId 6342)

Date: <YYYY-MM-DD>
Settlement: <GREG_SETTLEMENT_TESTNET>
VaultRelayer: <GREG_VAULT_RELAYER_TESTNET>
Authentication: <GREG_AUTH_TESTNET>
Pair: WETH → USDC
Order UID: <paste>
Settlement tx: <paste>
Time-to-settle: <seconds>
Verdict: PASS / DONE_WITH_CONCERNS — <details>
```

### Step 9: No commit (validation-only — final log lands in Task 12)

## Task 8: Deploy contracts on MegaETH mainnet (Stage 2)

**Files:**
- Modify: `infra/megaeth/.env` (fill in `GREG_*_MAINNET` addresses + `MEGAETH_MAINNET_RPC`)

Pre-requisites:
- Stage 1 (Tasks 5-7) PASSED.
- Operator confirms MegaETH mainnet RPC URL by checking `https://docs.megaeth.com` or `https://chainlist.org/chain/4326`.
- Deployer EOA has ~0.05 mainnet ETH (operator-funded — bridge from Ethereum, or use a CEX with MegaETH withdrawal support).

### Step 1: Confirm mainnet RPC + populate `.env`

Edit `/Users/scep/greg/infra/megaeth/.env`:

```ini
MEGAETH_MAINNET_RPC=<from chainlist or docs.megaeth.com>
MEGAETH_MAINNET_EXPLORER=<mainnet explorer URL>
```

Verify reachability:
```bash
RPC=$(grep MEGAETH_MAINNET_RPC /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
cast chain-id --rpc-url "$RPC"
```
Expected: `4326`.

### Step 2: Fund deployer on mainnet

```bash
DEPLOYER_ADDR=$(grep GREG_MEGAETH_DEPLOYER_ADDRESS /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR" --ether
```
Expected: ≥ 0.05 ETH.

### Step 3: Run deploy on mainnet

```bash
cd /Users/scep/greg/infra/megaeth/deploy
./run-deploy.sh megaeth-mainnet
```

Capture the three deployed addresses (Authentication, Settlement, VaultRelayer) from the log.

### Step 4: Update `.env` with mainnet addresses

```ini
GREG_AUTH_MAINNET=0x<address>
GREG_SETTLEMENT_MAINNET=0x<address>
GREG_VAULT_RELAYER_MAINNET=0x<address>
```

### Step 5: Add driver-submitter to mainnet auth allowlist

```bash
DEPLOYER_PK=$(security find-generic-password -a "greg-megaeth-deployer" -s "greg-megaeth-deployer" -w)
RPC=$(grep MEGAETH_MAINNET_RPC /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
AUTH=$(grep GREG_AUTH_MAINNET /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
DRIVER=0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F

cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" "$AUTH" \
  "addSolver(address)" "$DRIVER" 2>&1 | tail -10

cast call --rpc-url "$RPC" "$AUTH" "isSolver(address)(bool)" "$DRIVER"
```
Expected: `true`.

### Step 6: Verify deployments on mainnet explorer

Visit `<mainnet explorer>/address/<each contract>`. Expect: contracts visible. Verification (source upload) is a Phase 3.x task, not blocking.

### Step 7: No commit (mainnet addresses are operational state in `.env`; tracked at close-out)

## Task 9: Adapt configs + compose for MegaETH mainnet

**Files:**
- Create: `infra/megaeth/configs/mainnet/{orderbook,autopilot,driver,baseline}.toml`
- Create: `infra/megaeth/docker-compose.mainnet.yml`

### Step 1: Copy testnet configs into `mainnet/` subdirectory

```bash
cd /Users/scep/greg
mkdir -p infra/megaeth/configs/mainnet
cp infra/megaeth/configs/{orderbook,autopilot,driver,baseline}.toml \
   infra/megaeth/configs/mainnet/
```

### Step 2: Edit each mainnet config

In each of the four mainnet TOMLs:
- `chain-id` → `"4326"`
- Settlement / VaultRelayer / Authentication addresses → `GREG_*_MAINNET` (from Task 8 .env)
- WETH + base-token addresses → MegaETH **mainnet** equivalents (look up via mainnet explorer or docs.megaeth.com)
- DEX presets → MegaETH mainnet DEX deployments. Uniswap V3 factory may live at the same canonical address as on the testnet — verify with `cast code`.
- `node-url` / `simulation-node-url` → `${MEGAETH_MAINNET_RPC}` (or hardcoded mainnet RPC if env-var substitution isn't supported by the upstream config)

### Step 3: Write `docker-compose.mainnet.yml`

Copy from testnet:
```bash
cp infra/megaeth/docker-compose.testnet.yml infra/megaeth/docker-compose.mainnet.yml
```

Edit:
- Volume mounts → `./configs/mainnet/<file>.toml`
- `ETH_RPC_URL` → `${MEGAETH_MAINNET_RPC}`
- File header comment → mainnet variant.

Verify parses:
```bash
docker compose -f infra/megaeth/docker-compose.mainnet.yml --env-file infra/megaeth/.env config | head -20
```

### Step 4: Commit

```bash
cd /Users/scep/greg
git add infra/megaeth/configs/mainnet/ infra/megaeth/docker-compose.mainnet.yml
git status
git commit -m "infra(megaeth): mainnet configs + compose (chain-id 4326, our deployed contracts)"
git push
```

## Task 10: Stage-2 e2e — first swap on MegaETH mainnet (Phase 3 gate)

**Files:** none modified directly; final evidence captured in Task 12's validation log.

### Step 1: Boot the mainnet stack

```bash
cd /Users/scep/greg
docker compose -f infra/megaeth/docker-compose.mainnet.yml --env-file infra/megaeth/.env up -d
sleep 30
docker compose -f infra/megaeth/docker-compose.mainnet.yml ps
```
Expected: 6 services up.

### Step 2: Fund + wrap on mainnet

The test wallet `0x412cbCCe…294aB` needs ~0.005 mainnet ETH. Operator bridges from Ethereum or sends from an existing wallet.

```bash
TEST_PK=$(security find-generic-password -s greg-chiado-test -w)
TEST_ADDR=0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB
RPC=$(grep MEGAETH_MAINNET_RPC /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)
WETH=<MegaETH mainnet WETH from Task 9 base-tokens>
RELAYER=$(grep GREG_VAULT_RELAYER_MAINNET /Users/scep/greg/infra/megaeth/.env | cut -d= -f2)

cast balance --rpc-url "$RPC" "$TEST_ADDR" --ether
cast send --rpc-url "$RPC" --private-key "$TEST_PK" "$WETH" "deposit()" --value 0.001ether
cast send --rpc-url "$RPC" --private-key "$TEST_PK" "$WETH" "approve(address,uint256)" \
  "$RELAYER" 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
```

### Step 3: Quote → sign → submit (same recipe as Stage 1, mainnet substitutes)

EIP-712 domain:
```typescript
{
  name: 'Gnosis Protocol',
  version: 'v2',
  chainId: 4326,
  verifyingContract: <GREG_SETTLEMENT_MAINNET>
}
```
Submit to `http://localhost:8080/api/v1/orders` (our own orderbook).

### Step 4: Watch + capture settlement

Same loop as Stage 1. Capture:
- Order UID
- Settlement tx hash
- Block number
- Time-to-settle
- Mainnet explorer URL for the tx

### Step 5: Capture Stage-2 evidence (for Task 12 final log)

Append to `/tmp/greg-phase3-stage2.md`:

```markdown
## Stage 2: MegaETH mainnet (chainId 4326) — Phase 3 phase gate

Date: <YYYY-MM-DD>
Settlement: <GREG_SETTLEMENT_MAINNET>
VaultRelayer: <GREG_VAULT_RELAYER_MAINNET>
Authentication: <GREG_AUTH_MAINNET>
Pair: WETH → USDC (or whatever pair has liquidity)
Order UID: <paste>
Settlement tx: <paste>
Block: <paste>
Time-to-settle: <seconds>
Explorer: <URL>
Verdict: PASS
```

### Step 6: No commit (final log in Task 12)

## Task 11: MegaETH foundation grant application — DRAFT ONLY in Phase 3 (submission deferred)

**Submission gated on:** real domain + real brand + real-user-validated UX + stable mainnet contracts. None of those exist yet at Phase 3 start. We commit the **draft** so the application materials exist; actual submission is a Phase 4+ task once production-ready is true.

**Files:**
- Create: `docs/superpowers/megaeth-grant-application.md`

Per [megaeth.com](https://www.megaeth.com/), the MegaETH Foundation has an ecosystem reserve (7.5% of supply / 750M MEGA) earmarked for developer grants, liquidity, and community rewards.

### Step 1: Find the application channel

Check:
- `https://docs.megaeth.com/grants` (or whatever the docs site has)
- The MegaETH Foundation Twitter / Discord
- Their public ecosystem program contact

### Step 2: Draft the application

Write `/Users/scep/greg/docs/superpowers/megaeth-grant-application.md`:

```markdown
# MegaETH Foundation Grant — Greg Application Draft

## Project: Greg

DCA + TWAP intent-broker on MegaETH. CoW-Protocol-derived; we deployed
unchanged audited bytecode and run our own solver / driver. First chain-native
intent-based DEX aggregator on MegaETH.

## Live URL
<production URL — Cloudflare Pages: https://greg-etm.pages.dev>

## Live contracts on MegaETH mainnet (chainId 4326)
- GPv2Settlement: `<GREG_SETTLEMENT_MAINNET>`
- GPv2VaultRelayer: `<GREG_VAULT_RELAYER_MAINNET>`
- GPv2AllowListAuthentication: `<GREG_AUTH_MAINNET>`

## Why MegaETH

MegaETH's 1-10ms blocks unlock UX patterns that don't work on slower chains
— sub-second batch auctions, real-time intent matching, instant settlement
notification. We're the first intent-broker on MegaETH; cow.fi, 1inch,
Velora, KyberSwap haven't deployed.

## What we want from the foundation

(Per MegaETH grant program requirements — fill in once requirements are known.)

Most relevant categories:
- Developer infrastructure grants — Greg ships routing infrastructure other
  apps can integrate.
- Liquidity bootstrapping — for the early-days "thin solver coverage" period.
- Marketing / co-launch — joint announcement when Greg's MegaETH deployment goes live.

## Founders

Clement (san-npm). Background: CMO Aleph Cloud, CEO COMMIT MEDIA Luxembourg.
Three-month build cadence: spec → Phase 0 (foundation) → Phase 1 (vendored
backend) → Phase 1.5 (partner-fee monetisation on CoW chains) → Phase 2 (UX
substrate) → Phase 2.5 (public launch) → Phase 2.6 (Cloudflare migration) →
**Phase 3 (this — MegaETH fork-deploy).** Full audit trail: github.com/san-npm/greg.

## Ask

<TBD per their application form>
```

### Step 3: Submit (operator action)

Per the foundation's actual application channel.

### Step 4: Commit the draft

```bash
cd /Users/scep/greg
git add docs/superpowers/megaeth-grant-application.md
git commit -m "docs(megaeth-grant): application draft"
git push
```

The actual submission is operator-driven; the plan only commits the draft so it's a stable artifact.

## Task 12: Phase 3 close-out

**Files:**
- Create: `docs/superpowers/phase-3-validation.md`
- Modify: `apps/frontend/.greg-divergences.md`? **No.** Phase 3 doesn't touch the frontend; nothing to track in cowswap-divergence file.
- Modify: `infra/megaeth/README.md`

### Step 1: Write `infra/megaeth/README.md` operator runbook

```markdown
# Greg MegaETH Stack (Phase 3)

This directory contains everything needed to operate Greg on MegaETH —
deployment scripts for our `GPv2Settlement` + `GPv2VaultRelayer` +
`GPv2AllowListAuthentication`, configs for the orderbook + autopilot +
driver + baseline solver, and docker-compose stacks for testnet (6342)
and mainnet (4326).

## Deployed contracts

- **Testnet (6342):**
  - Settlement: `<GREG_SETTLEMENT_TESTNET>`
  - VaultRelayer: `<GREG_VAULT_RELAYER_TESTNET>`
  - Authentication: `<GREG_AUTH_TESTNET>`
- **Mainnet (4326):**
  - Settlement: `<GREG_SETTLEMENT_MAINNET>`
  - VaultRelayer: `<GREG_VAULT_RELAYER_MAINNET>`
  - Authentication: `<GREG_AUTH_MAINNET>`

## Operator commands

- **Boot testnet stack:** `docker compose -f docker-compose.testnet.yml --env-file .env up -d`
- **Boot mainnet stack:** `docker compose -f docker-compose.mainnet.yml --env-file .env up -d`
- **Tear down:** `docker compose -f <compose> --env-file .env down`
- **Add a solver:** `cast send --rpc-url <rpc> --private-key <deployer> <auth> "addSolver(address)" <new-solver>`

## Open follow-ups (Phase 3.x)

- Verify Settlement / VaultRelayer / Authentication source on MegaETH explorer
- Transfer `GPv2AllowListAuthentication` ownership from deployer EOA → existing Gnosis Safe `0x858f0F5e…CeF8` (after lazy-deploying the Safe proxy on MegaETH)
- Recruit external solvers (currently we are the only solver)
```

Fill in the actual addresses captured during Tasks 5 and 8.

### Step 2: Write `docs/superpowers/phase-3-validation.md`

Combine the temp Stage-1 + Stage-2 capture files:

```markdown
# Phase 3 — MegaETH Fork-Deploy Validation Log

**Date:** <YYYY-MM-DD>
**Tag:** `v0.3-phase3`
**Repo HEAD:** `<git rev-parse HEAD>`

## Operator decisions

- D1 deployer EOA: `<address>` (Keychain `greg-megaeth-deployer`)
- D2 settlement authority: same as D1 initially; transfer to Gnosis Safe `0x858f0F5e…CeF8` deferred to Phase 3.x
- D3 driver-submitter: `0x00f98b…502F` (reused from Phase 1)
- D4 grant: <applied / deferred>

## Phase gate

| # | Gate | Evidence | Result |
|---|---|---|---|
| 1 | cowprotocol/contracts vendored at `contracts/` | git subtree commit `<sha>`, pinned upstream `<sha>` | PASS |
| 2 | Contracts compile locally | `yarn build` clean; artifacts at `<path>` | PASS |
| 3 | Hardhat config layered for MegaETH | `infra/megaeth/deploy/hardhat-megaeth.config.ts` defines testnet (6342) + mainnet (4326) | PASS |
| 4 | Contracts deployed on MegaETH testnet | Settlement `<addr>`, VaultRelayer `<addr>`, Authentication `<addr>` | PASS |
| 5 | Driver-submitter in testnet allowlist | `isSolver(0x00f98b…)` returns `true` on testnet auth | PASS |
| 6 | Stage-1 e2e — testnet swap settled via Greg's stack | tx `<hash>` block `<n>` on `https://megaexplorer.xyz` | PASS |
| 7 | Contracts deployed on MegaETH mainnet | Settlement `<addr>`, VaultRelayer `<addr>`, Authentication `<addr>` | PASS |
| 8 | Driver-submitter in mainnet allowlist | `isSolver(0x00f98b…)` returns `true` on mainnet auth | PASS |
| 9 | **Stage-2 e2e — mainnet swap settled** | tx `<hash>` on mainnet explorer | **PASS — phase gate** |
| 10 | Foundation grant application drafted (D4) | `docs/superpowers/megaeth-grant-application.md` | <PASS / DEFERRED> |

## Stage 1 evidence

(Combine `/tmp/greg-phase3-stage1.md` content here.)

## Stage 2 evidence

(Combine `/tmp/greg-phase3-stage2.md` content here.)

## Phase 3 verdict: PASS

Greg is the first intent-based aggregator on MegaETH. Our settlement contracts
hold the allowlist; our solver is registered. End-to-end swap settles via
Greg's own stack on real MegaETH mainnet.

## Next phase

Phase 3.5 — Treasury tier (T2 self-serve), or whatever Clement prioritises.

## Open follow-ups

- Transfer auth ownership to Safe multisig
- Verify contract source on MegaETH explorer
- Recruit additional external solvers
- Set up monitoring on Greg's MegaETH stack (Grafana / Prometheus)
- Apply for MegaETH grant if not already submitted
- Document operator runbooks for emergency response (auth misconfig, solver freeze, etc.)
```

### Step 3: Tag

```bash
cd /Users/scep/greg
git add docs/superpowers/phase-3-validation.md infra/megaeth/README.md
git commit -m "docs(phase-3): close-out — Greg deployed on MegaETH mainnet, first sovereign settlement"
git push
git tag -a v0.3-phase3 -m "Phase 3 — MegaETH Fork-Deploy PASS

CoW Protocol's audited GPv2Settlement + GPv2VaultRelayer +
GPv2AllowListAuthentication deployed unchanged on MegaETH mainnet
(chainId 4326). Our deployer EOA owns the allowlist. Driver-submitter
0x00f98b...502F is registered. First swap settled via Greg's own
stack.

Greg is now the chain-native intent broker on MegaETH.

Stage 1 testnet (6342): see phase-3-validation.md.
Stage 2 mainnet (4326): see phase-3-validation.md."
git push --tags
```

### Step 4: Close issue #4

```bash
gh issue close 4 --repo san-npm/greg --comment "Phase 3 complete and tagged \`v0.3-phase3\`. Greg deployed sovereign on MegaETH mainnet. Validation: \`docs/superpowers/phase-3-validation.md\`."
```

### Step 5: Update memory

Edit `~/.claude/projects/-Users-scep/memory/project_greg.md`:
- Append Phase 3 PASS to gates section
- Add `v0.3-phase3` to tags
- Add MegaETH addresses + RPCs
- Update Next step to Phase 3.5 (Treasury tier) or whatever Clement prioritises next

Edit `~/.claude/projects/-Users-scep/memory/MEMORY.md`:
- Update one-liner

---

## Self-Review Notes

**Spec coverage**

- Contract deployment unchanged: Tasks 2-3 (vendor + build) + Tasks 5, 8 (deploy testnet + mainnet).
- Own AllowListAuthentication: Tasks 5, 8 deploy our auth; Task 5 Step 5 + Task 8 Step 5 register driver.
- Wire vendored services as runtime: Tasks 6, 9 (configs) + Tasks 7, 10 (boot + e2e).
- First swap on MegaETH mainnet: Task 10 (the phase gate).
- Foundation grant application: Task 11 (parallel, doesn't gate).

**Placeholders**

A few `<placeholder>` markers in code blocks where runtime values must be substituted (deployed addresses, tx hashes, RPC URLs once mainnet is confirmed). All are explicitly flagged. No `TBD` or "fill in later" hand-waves.

**Type / name consistency**

- Auth contract function names: `addSolver(address)` per upstream cowprotocol/contracts. If actual name differs (`grantSolverRole`, `setSolver`, etc.), Task 5 Step 5 says to inspect the source and adapt.
- Env var names follow `GREG_<CONTRACT>_<NETWORK>` pattern consistently.
- Chain IDs: 6342 (testnet), 4326 (mainnet) — referenced consistently.

**Risk acknowledged**

- **Mainnet contract deploy is irreversible.** If we deploy with wrong constructor args, we redeploy. The `.env` records the wrong addresses; cleanup is operational.
- **Auth ownership stays on the deployer EOA** until a follow-up task transfers to the Safe. If the deployer key is lost or compromised, allowlist management is impacted. Mitigation: transfer ownership to Safe early in Phase 3.x.
- **DEX coverage on MegaETH testnet/mainnet may be thin.** Task 6 / Task 9 instruct the implementer to seed liquidity if no V2/V3 deploy with WETH-pair exists. This may add operational cost (~$10-50 of testnet/mainnet ETH).
- **Mainnet RPC endpoint at task time may differ from earlier research.** Task 8 Step 1 explicitly verifies via `cast chain-id`.

**Out of scope (to prevent drift)**

- Foundation grant **acceptance** (we just apply; acceptance is foundation-controlled).
- Auth ownership transfer to Safe (Phase 3.x follow-up).
- Source verification on MegaETH explorer (Phase 3.x).
- External solver recruitment (Phase 4+).
- Frontend changes — Phase 3 is purely backend / deploy work.
- Treasury tier (T2 self-serve) — Phase 3.5.
- API tier (T3 self-serve) — Phase 4.

## Sources

- [Greg spec amendment 2026-05-03](../specs/2026-05-03-greg-design-amendment.md)
- [Phase 1 plan (services stack origin)](2026-05-02-greg-phase-1-local-self-hosted-stack.md)
- [`cowprotocol/contracts`](https://github.com/cowprotocol/contracts) — Solidity source for Settlement / VaultRelayer / Authentication
- [`cowprotocol/services`](https://github.com/cowprotocol/services) — already vendored at `apps/backend/`
- [MegaETH official site](https://www.megaeth.com/) — chain ecosystem
- [MegaETH testnet RPC + chain settings (Chainlist 6342)](https://chainlist.org/chain/6342)
- [MegaETH mainnet RPC + chain settings (Chainlist 4326)](https://chainlist.org/chain/4326)
- [MegaETH testnet portal](https://testnet.megaeth.com/) — faucets + bridges
- [MegaETH explorer (testnet)](https://megaexplorer.xyz)
- [MegaETH docs](https://docs.megaeth.com/) — official documentation, grant program info
- [Uniswap V3 deployment addresses](https://docs.uniswap.org/contracts/v3/reference/deployments/) — deterministic factory address verification
