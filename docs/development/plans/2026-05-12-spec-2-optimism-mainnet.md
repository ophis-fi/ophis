# Spec 2 — Optimism mainnet backend (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Greg's first production mainnet backend on Optimism (chain 10), settling a real WETH→USDC trade through Uniswap V3 liquidity.

**Architecture:** **Branch A locked** — Aleph Cloud for both the L2 RPC node and the chain stack. Clement is the CMO; Aleph compute is free for him. Single VM gets bigger to host op-node + op-geth + chain stack together, OR split across two Aleph VMs (decided at execution time based on Aleph's volume-attachment ergonomics).

**Tech Stack:** op-geth + op-node (Optimism execution+consensus client pair from `ethereum-optimism/optimism`), Docker Compose, postgres:16-alpine, CoW services Rust stack (vendored at `apps/backend/`), Cloudflared, viem + cow-sdk for smoke test. Liquidity routed through Uniswap V3 on Optimism (factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, canonical UniV3 init code hash).

**Open questions from spec — resolved here:**
1. **Branch:** A (Aleph).
2. **Uniswap V3 subgraph reliability:** Use `https://api.thegraph.com/subgraphs/name/ianlapham/optimism-post-regenesis` initially; self-host on the same VM as a fallback if it goes down.
3. **L1 follow-RPC for op-node:** Round-robin `https://eth.llamarpc.com`, `https://cloudflare-eth.com`, `https://ethereum.publicnode.com`. op-node tolerates failures and retries.
4. **op-geth snapshot source:** Optimism's official snapshot at `https://snapshots.optimism.io/mainnet-bedrock-latest.tar.zstd` (current 2026-05 link). Aim for the "Archive" if disk allows, else "Full". Confirm size before download.
5. **Test wallet provisioning:** New Keychain `greg-optimism-test`. Fund 0.01 OP ETH + 0.001 WETH from `greg-optimism-deployer` post-deploy.
6. **Network topology in Branch A:** If single-VM hosts everything, no inter-VM networking needed. If split, **Tailscale tailnet** between the two Aleph VMs (Cloudflare Tunnel internal-only is overkill; Aleph private mesh is undocumented).

---

## File Structure

To be created:

| Path | Responsibility |
|---|---|
| `contracts/hardhat-megaeth.config.ts` | EXISTING — already covers optimism-mainnet network |
| `infra/optimism/deploy/deploy-mainnet-all.sh` | EXISTING — already written in PR #22 |
| `infra/optimism-mainnet/docker-compose.mainnet.yml` | CoW stack containers, port-remapped to 8102/8103/9022/5435 |
| `infra/optimism-mainnet/.env` (gitignored) | Postgres creds, OP_MAINNET_RPC (=our op-geth), mainnet contract addresses |
| `infra/optimism-mainnet/configs/autopilot.toml` | mainnet RPC + mainnet contracts |
| `infra/optimism-mainnet/configs/driver.toml` | mainnet RPC + UniV3 liquidity source + driver-submitter PK env-injected |
| `infra/optimism-mainnet/configs/orderbook.toml` | mainnet RPC + mainnet contracts |
| `infra/optimism-mainnet/configs/baseline.toml` | baseline solver config (copy from existing) |
| `infra/optimism-mainnet/scripts/smoke-test-e2e.ts` | E2E smoke with full settlement-tx assertion |
| `infra/optimism-mainnet/scripts/package.json`, `tsconfig.json` | smoke-test deps |
| `infra/optimism/node/docker-compose.yml` | op-node + op-geth deployment, with mounted snapshot |
| `infra/optimism/node/.env` (gitignored) | OP_NODE_L1_RPC list, JWT secret for engine API |
| `infra/optimism/node/README.md` | runbook for the node side (snapshot URL, sync time, restart) |

Existing files updated:
- `infra/optimism/.env` (deploy script appends GREG_*_OP_MAINNET addresses)
- `infra/cloudflare/ophis-chain-backends.md` (extended with optimism-mainnet row)
- `apps/rebate-indexer/src/alerter.ts` (extend to watch OP mainnet driver-submitter balance)

---

## Tasks

### Task 1: Provision the Aleph Cloud VM(s) for op-node + chain stack

**Files:** none (Aleph console / aleph-client CLI)

Pre-condition: Clement has aleph-client installed locally (it lives at `~/.local/pipx/venvs/aleph-client/`).

- [ ] **Step 1: Pick split-vs-single architecture**

Decision criteria:
- **Single VM** (all on one box): simplest. Needs 1 TB NVMe + ~32 GB RAM (op-geth wants 16 GB + chain stack wants 8-10 GB + headroom).
- **Split** (op-node on one VM, chain stack on vm4): cleaner separation, but requires Tailscale or similar between the two boxes.

Recommendation: **single VM**, named `vm-greg-op-mainnet`. Lower ops complexity.

- [ ] **Step 2: Provision via aleph-client**

```bash
aleph instance create \
  --name vm-greg-op-mainnet \
  --cpu 8 \
  --memory 32768 \
  --volume-mount /:1000000 \  # 1 TB root volume (NVMe)
  --image debian-12 \
  --ssh-key ~/.ssh/aleph-greg.pub
```

(Exact aleph-client flags depend on the current version; verify with `aleph instance create --help` first. The `Pydantic GpuDevice.model required` bug from Spec 1 may still need patching at `~/.local/pipx/venvs/aleph-client/lib/python3.9/site-packages/aleph/sdk/client/services/crn.py` if it resurfaces.)

- [ ] **Step 3: Note the SSH endpoint**

Record `<host>:<port>` and add to memory under `project_greg.md` Phase 3.5 section.

- [ ] **Step 4: Verify access**

```bash
ssh -i ~/.ssh/aleph-greg -p <port> root@<host> 'uname -a; df -h /'
```

Expect 1TB free on /.

### Task 2: Install op-node + op-geth on the new VM

**Files:**
- Create: `infra/optimism/node/docker-compose.yml`
- Create: `infra/optimism/node/.env` (gitignored)
- Create: `infra/optimism/node/README.md`

- [ ] **Step 1: Install Docker + Docker Compose**

```bash
ssh ... 'curl -fsSL https://get.docker.com | sh && systemctl enable --now docker'
```

- [ ] **Step 2: Author `infra/optimism/node/docker-compose.yml`**

Pattern: use ethereum-optimism's official Docker images (`us-docker.pkg.dev/oplabs-tools-artifacts/images/op-geth` and `op-node`). Two services + a healthcheck, sharing a volume. Engine API JWT secret bind-mounted.

Pin to the latest stable release tag at write time (check https://github.com/ethereum-optimism/optimism/releases).

- [ ] **Step 3: Author `.env` with L1 follow-RPC list**

```
OP_NODE_L1_RPC=https://eth.llamarpc.com
OP_NODE_L1_RPC_FALLBACK=https://cloudflare-eth.com,https://ethereum.publicnode.com
OP_NODE_JWT_SECRET=<32-byte random hex>
```

Generate JWT:
```bash
openssl rand -hex 32 > /etc/op-node/jwt.hex
```

- [ ] **Step 4: Download snapshot for op-geth**

```bash
# Disk usage check first
df -h /
# Snapshot is ~700 GB compressed, ~1.2 TB uncompressed
wget -O /var/lib/op-geth-snapshot.tar.zstd \
  https://snapshots.optimism.io/mainnet-bedrock-latest.tar.zstd
# Extract
zstd -d /var/lib/op-geth-snapshot.tar.zstd | tar -x -C /var/lib/op-geth-data/
```

(Verify exact snapshot URL is still live at execution time; Optimism rotates these. Fall back to https://kb.optimism.io or third-party snapshots like Quicknode/dwellir.)

- [ ] **Step 5: Bring up node**

```bash
cd /infra/optimism/node && docker compose up -d
docker compose logs -f op-geth | tail -50
```

Wait for sync. Initial state-sync from snapshot is ~30 min; catching up to head from snapshot block ~2-12 hr.

- [ ] **Step 6: Verify synced**

```bash
curl -s http://localhost:8545 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_syncing","id":1}'
```

Expect `"result":false`.

```bash
curl -s http://localhost:8545 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'
```

Compare to https://optimistic.etherscan.io. Should be within 5 blocks.

- [ ] **Step 7: Author `infra/optimism/node/README.md`**

Runbook: snapshot URL, sync time, restart command, log inspection, disk usage check.

- [ ] **Step 8: Commit**

```bash
git add infra/optimism/node/docker-compose.yml infra/optimism/node/README.md
git commit -m "feat(optimism/node): op-node + op-geth stack for OP mainnet RPC"
```

### Task 3: Create Optimism mainnet deployer wallet + fund

**Files:** none (Keychain + on-chain ops)

- [ ] **Step 1: Generate wallet**

```bash
cast wallet new
```

Save private key:
```bash
security add-generic-password -U -a "$USER" -s greg-optimism-deployer \
  -w "<PRIVATE_KEY>"
```

Verify:
```bash
security find-generic-password -l greg-optimism-deployer -w | cast wallet address --private-key -
```

- [ ] **Step 2: Bridge ~0.05 OP ETH to the deployer address**

Cheapest path on a low-cost bridge — Stargate / Across / native bridge. Operator-side.

- [ ] **Step 3: Bridge ~0.05 OP ETH to driver-submitter**

`0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` (same as MegaETH driver).

- [ ] **Step 4: Verify balances**

```bash
RPC=http://<vm-greg-op-mainnet>:8545  # our op-geth, not public
DEPLOYER=$(security find-generic-password -l greg-optimism-deployer -w | cast wallet address --private-key -)
cast balance --rpc-url $RPC $DEPLOYER --ether
cast balance --rpc-url $RPC 0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F --ether
```

Both ≥ 0.05 ETH.

### Task 4: Run deploy-mainnet-all.sh

**Files:**
- Read+execute: `infra/optimism/deploy/deploy-mainnet-all.sh` (already in repo, PR #22)
- Modify: `infra/optimism/.env` (script appends)

- [ ] **Step 1: Point OP_MAINNET_RPC at our node**

Edit `infra/optimism/.env`:
```
OP_MAINNET_RPC=http://<vm-greg-op-mainnet>:8545
```

If the new VM is on a public IP, **firewall the 8545 port to localhost only on the VM AND tunnel via SSH** to Mac for the deploy:
```bash
ssh -L 8545:localhost:8545 root@<vm-greg-op-mainnet>
```

In a separate shell while the tunnel is up:
```bash
OP_MAINNET_RPC=http://localhost:8545 ./infra/optimism/deploy/deploy-mainnet-all.sh
```

- [ ] **Step 2: Verify all addresses written**

Read tail of `infra/optimism/.env`:
```bash
tail -10 infra/optimism/.env
```

Should see all `GREG_*_OP_MAINNET` keys.

- [ ] **Step 3: Sanity-check contracts on chain**

Per the megaeth plan's Task 2 Step 3 pattern; substitute OP mainnet addresses.

- [ ] **Step 4: No commit (`.env` is gitignored)**

### Task 5: Create `infra/optimism-mainnet/` chain stack

**Files:**
- Create: `infra/optimism-mainnet/` tree

- [ ] **Step 1: Copy from `infra/optimism/`**

```bash
mkdir -p infra/optimism-mainnet/configs infra/optimism-mainnet/scripts
cp infra/optimism/docker-compose.testnet.yml infra/optimism-mainnet/docker-compose.mainnet.yml
cp infra/optimism/configs/*.toml infra/optimism-mainnet/configs/
```

- [ ] **Step 2: Port-remap**

In `docker-compose.mainnet.yml`, change ports to `8102/8103/9022/5435`.

- [ ] **Step 3: Update `configs/*.toml`**

`autopilot.toml`, `driver.toml`, `orderbook.toml`:
- `node-url` + `simulation-node-url` → `http://<vm-greg-op-mainnet-private-IP>:8545` (or `localhost:8545` if single-VM and chain stack is on same VM)
- `[contracts]` / `[shared.contracts]` → mainnet-deployed Greg addresses
- chain ID env → `10`

`driver.toml`:
- Replace `[[liquidity.uniswap-v2]]` block with `[[liquidity.uniswap-v3]]`:
  ```toml
  [[liquidity.uniswap-v3]]
  router = "0xE592427A0AEce92De3Edee1F18E0157C05861564"  # UniV3 SwapRouter on OP
  factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
  subgraph-url = "https://api.thegraph.com/subgraphs/name/ianlapham/optimism-post-regenesis"
  ```

`baseline.toml`: copy from optimism testnet baseline.toml.

- [ ] **Step 4: Write `.env.example`**

Reference values from `infra/optimism/.env` mainnet section, plus Postgres creds + driver-submitter PK ref.

- [ ] **Step 5: Commit**

```bash
git add infra/optimism-mainnet/
git commit -m "feat(optimism-mainnet): scaffold infra/optimism-mainnet/ chain stack"
```

### Task 6: Deploy chain stack to the VM

**Files:** none (operator action)

- [ ] **Step 1: Rsync to VM**

```bash
/opt/homebrew/bin/rsync -az --exclude='node_modules' --exclude='.env' \
  infra/optimism-mainnet/ \
  root@<vm-greg-op-mainnet>:/srv/ophis/infra/optimism-mainnet/
```

- [ ] **Step 2: Create `.env` on VM**

Same pattern as Spec 3 plan Task 5. Postgres creds + RPC + chain ID.

- [ ] **Step 3: Bring up + verify db healthy + no 429s**

Same as Spec 3 plan Task 5 Steps 3-5.

### Task 7: Wire `optimism.ophis.fi` Cloudflare tunnel

**Files:** same pattern as Spec 3 plan Task 6.

Single-level subdomain `optimism.ophis.fi` (don't try `api.optimism.ophis.fi` per the Spec 1 Universal SSL lesson).

### Task 8: Smoke test

**Files:**
- Create: `infra/optimism-mainnet/scripts/smoke-test-e2e.ts`, `package.json`, `tsconfig.json`

- [ ] **Step 1: Generate test wallet**

Same pattern as Spec 3 plan Task 7 Step 1, but for `greg-optimism-test`.

- [ ] **Step 2: Mirror Spec 1's optimism-sepolia smoke + Spec 3's mainnet additions**

Key params:
- chain ID `10`, RPC = our op-geth
- `GPV2_SETTLEMENT = GREG_SETTLEMENT_OP_MAINNET`
- Buy token: native USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`
- 0.001 WETH → at-least-3.5 USDC
- **Exit 0 only on `status: fulfilled` + non-empty `txHash`**

- [ ] **Step 3: Install + run**

```bash
cd infra/optimism-mainnet/scripts && pnpm install --ignore-workspace
OPTIMISM_MAINNET_USDC=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 \
  OPTIMISM_MAINNET_TEST_WALLET_PK=$(security find-generic-password -l greg-optimism-test -w) \
  pnpm smoke
```

Expected: `✓ E2E settled, tx 0x<hash>`.

- [ ] **Step 4: Verify on chain**

```bash
cast tx <hash> --rpc-url http://<vm-greg-op-mainnet>:8545
```

Confirms settlement landed.

- [ ] **Step 5: Commit smoke test**

```bash
git add infra/optimism-mainnet/scripts/
git commit -m "feat(optimism-mainnet): smoke test"
```

### Task 9: Documentation + memory + telegram alerts

Same shape as Spec 3 plan Task 8.

- [ ] **Step 1: Update runbook** — add optimism-mainnet row to "Useful constants" table, add Aleph node VM SSH entry.
- [ ] **Step 2: Mark Spec 2 SHIPPED** in the spec doc.
- [ ] **Step 3: Update memory** — `project_greg.md` Phase 3.5 lists optimism-mainnet as the third live mainnet chain stack.
- [ ] **Step 4: Extend alerter** for OP mainnet driver-submitter gas balance.
- [ ] **Step 5: Commit + PR + merge**

---

## Done definition

All Task 9 boxes checked PLUS:
- `pnpm smoke` reproducibly passes
- `cast tx <hash>` confirms on chain
- `https://optimism.ophis.fi/api/v1/version` resolves
- Telegram alert fires on artificially-drained driver balance
- PR merged
