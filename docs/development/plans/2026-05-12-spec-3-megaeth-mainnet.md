> ⚠️ **DEPRECATED 2026-05-19** — this document refers to a chain
> deployment that has been paused indefinitely (HL paused per the
> 2026-05-19 strategic pivot; MegaETH paused 2026-05-18). The repo
> retains it as historical record of design + implementation work.
> Do NOT rely on it for current operational truth. Source of truth
> for current state: `project_ophis_next_session_guide.md` +
> `project_ophis_roadmap.md`.

# Spec 3 — MegaETH mainnet backend (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Ophis's first mainnet backend on MegaETH (chain 4326), settling a real on-chain WETH→USDT0 trade through the self-hosted CoW stack.

**Architecture:** Co-tenant on existing vm4. New `infra/megaeth-mainnet/` from a copy of `infra/megaeth/`. Public RPC at `mainnet.megaeth.com/rpc` (verified handles our load). Ophis-deployed CoW core only — liquidity routes through **Kumbaya** (MegaETH's dominant DEX, ~$53M TVL, UniV3 fork at factory `0x68b34591f662508076927803c567Cc8006988a09`). New Cloudflare tunnel `ophis-megaeth-mainnet` → `megaeth.ophis.fi`.

**Tech Stack:** Solidity 0.7.6 (CoW contracts) via hardhat-deploy, Rust services from cowprotocol/services vendored at `apps/backend/`, Docker Compose, postgres:16-alpine, Cloudflared, viem + cow-sdk for smoke test.

**Open questions from spec — resolved here:**
1. **Liquidity source:** **Kumbaya UniV3** (not Ophis V2). No pool seeding needed. Custom init-code-hash `0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7`. Factory `0x68b34591f662508076927803c567Cc8006988a09`.
2. **Test pair:** At execution time, query Kumbaya's deepest WETH-quoted pool (likely WETH/USDC) and use that for the smoke test buy token.
3. **Deployer wallet bridge route:** Operator-side; not part of code. Document only.
4. **Test wallet:** New Keychain entry `ophis-megaeth-test`. Fund from deployer with ~0.005 MEGA.

---

## File Structure

To be created in this plan:

| Path | Responsibility |
|---|---|
| `infra/megaeth-mainnet/docker-compose.mainnet.yml` | CoW stack containers, port-remapped to 8104/8105/9003/5436 |
| `infra/megaeth-mainnet/.env` (gitignored) | Postgres creds, OP_MEGAETH_RPC, mainnet contract addresses |
| `infra/megaeth-mainnet/configs/autopilot.toml` | mainnet RPC + mainnet contracts |
| `infra/megaeth-mainnet/configs/driver.toml` | mainnet RPC + driver-submitter PK env-injected + Ophis V2 router liquidity source |
| `infra/megaeth-mainnet/configs/orderbook.toml` | mainnet RPC + mainnet contracts |
| `infra/megaeth-mainnet/configs/baseline.toml` | baseline solver config (copy from testnet) |
| `infra/megaeth-mainnet/scripts/smoke-test-e2e.ts` | E2E smoke test (mirror of Spec 1 optimism with mainnet addresses + tx-hash assertion) |
| `infra/megaeth-mainnet/scripts/package.json` | smoke-test dependencies (cow-sdk, viem, chalk) |
| `infra/megaeth-mainnet/scripts/tsconfig.json` | TS config |

Existing files that the plan invokes but does not modify:
- `infra/megaeth/deploy/deploy-mainnet-all.sh` (runs as Task 1)
- `infra/megaeth/deploy/seed-mainnet-pool.sh` (runs as Task 2)
- `infra/megaeth/v2-artifacts/UniswapV2Factory.json` + `UniswapV2Router02.json` (consumed by deploy-mainnet-all.sh)

Existing files that the plan updates:
- `infra/megaeth/.env` (deploy script appends OPHIS_*_MAINNET addresses)
- `infra/cloudflare/ophis-chain-backends.md` (extended with megaeth-mainnet row)
- `apps/rebate-indexer/src/alerter.ts` or co-located alerter (extend to watch driver-submitter balance on MegaETH mainnet)

---

## Tasks

### Task 1: Fund deployer + driver-submitter wallets on MegaETH mainnet

**Files:** none (operator-side)

- [ ] **Step 1: Send ≥ 0.05 MEGA to deployer wallet**

Deployer: `0xb398C789F8690357e2b3D2ef6d1CDe62B1e4D020`

Confirm:
```bash
cast balance 0xb398C789F8690357e2b3D2ef6d1CDe62B1e4D020 \
  --rpc-url https://mainnet.megaeth.com/rpc --ether
```
Expected: ≥ 0.05 MEGA.

- [ ] **Step 2: Send ≥ 0.05 MEGA to driver-submitter wallet**

Driver: `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F`

Same check:
```bash
cast balance 0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F \
  --rpc-url https://mainnet.megaeth.com/rpc --ether
```

No commit at this step — funding is off-chain. **No pool-seed funding needed** (Kumbaya is the liquidity source).

### Task 2: Modify deploy script + deploy CoW core + helpers on MegaETH mainnet

**Files:**
- Modify: `infra/megaeth/deploy/deploy-mainnet-all.sh` (comment out V2 section)
- Modify: `infra/megaeth/.env` (script appends after run)

- [ ] **Step 0 (pre-Step-1): Comment out V2 deploy in the script**

In `infra/megaeth/deploy/deploy-mainnet-all.sh`:
- Comment out the entire section `# --- 3. Uniswap V2 ---` through `echo "  V2 Router:   $OPHIS_V2_ROUTER_MAINNET"`
- Renumber sections (3 → no longer exists, 4 → 3 of 3)
- Remove `OPHIS_V2_FACTORY_MAINNET` + `OPHIS_V2_ROUTER_MAINNET` from the address-append cat block at the bottom
- Commit: `git commit -m "fix(megaeth): drop V2 deploy from mainnet bootstrap (Kumbaya is liquidity source)"`

- [ ] **Step 1: Verify deployer funded + RPC reachable**

```bash
cast chain-id --rpc-url https://mainnet.megaeth.com/rpc
# Expected: 4326
```

- [ ] **Step 2: Execute deploy-mainnet-all.sh**

```bash
cd /Users/scep/greg/infra/megaeth/deploy
./deploy-mainnet-all.sh 2>&1 | tee /tmp/megaeth-mainnet-deploy-$(date +%Y%m%d-%H%M%S).log
```

Expected output: `=== Done. Next: seed-mainnet-pool.sh after acquiring WETH+USDT0 in deployer wallet.`

Verifies:
- `OPHIS_SETTLEMENT_MAINNET` printed and non-zero
- `OPHIS_VAULT_RELAYER_MAINNET` printed
- `OPHIS_V2_ROUTER_MAINNET` printed
- `isSolver(driver): true` in final line

- [ ] **Step 3: Sanity-check deployed contracts on chain**

```bash
RPC=https://mainnet.megaeth.com/rpc
source /Users/scep/greg/infra/megaeth/.env
echo "Settlement code:" $(cast code --rpc-url $RPC $OPHIS_SETTLEMENT_MAINNET | head -c 20)
echo "VaultRelayer():" $(cast call --rpc-url $RPC $OPHIS_SETTLEMENT_MAINNET "vaultRelayer()(address)")
echo "AuthList isSolver(driver):" $(cast call --rpc-url $RPC $OPHIS_AUTH_MAINNET "isSolver(address)(bool)" 0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F)
```

Expected: settlement has bytecode (not `0x`), vaultRelayer matches `OPHIS_VAULT_RELAYER_MAINNET`, isSolver returns `true`.

- [ ] **Step 4: Commit nothing — `.env` is gitignored, scripts emit only on-chain state**

### Task 3: Identify Kumbaya target pool for smoke test

**Files:** none (read-only on-chain query)

- [ ] **Step 1: Find the deepest WETH-quoted pool on Kumbaya**

```bash
KUMBAYA_FACTORY=0x68b34591f662508076927803c567Cc8006988a09
WETH=0x4200000000000000000000000000000000000006
RPC=https://mainnet.megaeth.com/rpc

# UniV3 has multiple fee tiers per pair (100, 500, 3000, 10000)
# For each likely counter-token (USDC, USDT, ...) check all 4 fee tiers
# Pick whichever pool has the highest WETH balance.

# Example for USDC (replace with actual MegaETH USDC address from a Kumbaya pool):
# USDC=0x???
# for fee in 100 500 3000 10000; do
#   POOL=$(cast call --rpc-url $RPC $KUMBAYA_FACTORY "getPool(address,address,uint24)(address)" $WETH $USDC $fee)
#   if [ "$POOL" != "0x0000000000000000000000000000000000000000" ]; then
#     BAL=$(cast call --rpc-url $RPC $WETH "balanceOf(address)(uint256)" $POOL)
#     echo "fee=$fee pool=$POOL weth=$BAL"
#   fi
# done
```

Record the chosen `(pool address, fee tier, counter token)` in a temp note. Use that token as the smoke-test buy token.

- [ ] **Step 2: No commit — investigative only.**

### Task 4: Create `infra/megaeth-mainnet/` from testnet template

**Files:**
- Create: `infra/megaeth-mainnet/` (whole tree)
- Reference: `infra/megaeth/docker-compose.testnet.yml`

- [ ] **Step 1: Copy structure**

```bash
cd /Users/scep/greg
mkdir -p infra/megaeth-mainnet/configs infra/megaeth-mainnet/scripts
cp infra/megaeth/docker-compose.testnet.yml infra/megaeth-mainnet/docker-compose.mainnet.yml
cp infra/megaeth/configs/*.toml infra/megaeth-mainnet/configs/
cp infra/megaeth/.env.example infra/megaeth-mainnet/.env.example
```

- [ ] **Step 2: Port-remap in docker-compose.mainnet.yml**

Edit `infra/megaeth-mainnet/docker-compose.mainnet.yml`: change every port mapping in the orderbook/driver/baseline/db services to the mainnet allocations:
- orderbook: host `8104:80`
- driver: host `8105:80`
- baseline: host `9003:80`
- db: host `5436:5432`

Verify port collisions by:
```bash
grep -rh "ports:" infra/{rebate-indexer,optimism,megaeth,megaeth-mainnet}/docker-compose*.yml | sort -u
```

No duplicates expected.

- [ ] **Step 3: Update configs/*.toml to point at mainnet**

`autopilot.toml`, `orderbook.toml`, `driver.toml`:
- `node-url = "https://mainnet.megaeth.com/rpc"`
- `simulation-node-url = "https://mainnet.megaeth.com/rpc"`
- `[contracts]` / `[shared.contracts]`:
  - `settlement = "<OPHIS_SETTLEMENT_MAINNET>"`
  - `balances = "<OPHIS_BALANCES_MAINNET>"`
  - `signatures = "<OPHIS_SIGNATURES_MAINNET>"`
  - `native-token = "0x4200000000000000000000000000000000000006"` (MegaETH WETH; verify mainnet has same predeploy address)
  - `hooks = "<OPHIS_HOOKS_TRAMPOLINE_MAINNET>"`

`driver.toml` also gets:
- `[[liquidity.uniswap-v2]]` block with `router = "<OPHIS_V2_ROUTER_MAINNET>"`, `pool-code = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f"` (standard UniV2; our V2 fork uses standard hash, verified during Spec 1)

- [ ] **Step 4: Write `infra/megaeth-mainnet/.env.example` with placeholder names**

Same shape as `infra/megaeth/.env` but with mainnet keys.

- [ ] **Step 5: Commit**

```bash
git add infra/megaeth-mainnet/
git commit -m "feat(megaeth-mainnet): scaffold infra/megaeth-mainnet/ from testnet template"
```

### Task 5: Deploy chain stack to vm4 + verify

**Files:** None (operator action on VM)

- [ ] **Step 1: Rsync to VM**

```bash
/opt/homebrew/bin/rsync -az --delete \
  --exclude='node_modules' --exclude='.env' \
  infra/megaeth-mainnet/ \
  root@REDACTED_ORIGIN_IP:<ssh-port>:/srv/ophis/infra/megaeth-mainnet/
```

(Adjust SSH command for the actual key location; `~/.ssh/<deploy-key> -p <ssh-port>` per Spec 1 runbook.)

- [ ] **Step 2: Create `.env` on VM with mainnet secrets**

```bash
ssh -p <ssh-port> -i ~/.ssh/<deploy-key> root@REDACTED_ORIGIN_IP 'cat > /srv/ophis/infra/megaeth-mainnet/.env <<EOF
POSTGRES_USER=greg
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=postgres
DB_WRITE_URL=postgresql://greg:<generated>@db:5432/postgres
DB_READ_URL=postgresql://greg:<generated>@db:5432/postgres
MEGAETH_MAINNET_RPC=https://mainnet.megaeth.com/rpc
MEGAETH_MAINNET_CHAIN_ID=4326
EOF
chmod 600 /srv/ophis/infra/megaeth-mainnet/.env'
```

- [ ] **Step 3: Bring up stack**

```bash
ssh -p <ssh-port> -i ~/.ssh/<deploy-key> root@REDACTED_ORIGIN_IP 'cd /srv/ophis/infra/megaeth-mainnet && docker compose -f docker-compose.mainnet.yml up -d'
```

- [ ] **Step 4: Verify containers up + db healthy**

```bash
ssh -p <ssh-port> -i ~/.ssh/<deploy-key> root@REDACTED_ORIGIN_IP 'docker ps --filter "name=megaeth-mainnet" --format "table {{.Names}}\t{{.Status}}"'
```

Expect 5 containers, db healthy.

- [ ] **Step 5: Verify no 429s / no errors in driver logs for 5 minutes**

```bash
ssh -p <ssh-port> -i ~/.ssh/<deploy-key> root@REDACTED_ORIGIN_IP 'docker logs megaeth-mainnet-driver-1 --since 5m 2>&1 | grep -ciE "error|warn|429"'
```

Count should be near 0.

### Task 6: Wire Cloudflare tunnel `ophis-megaeth-mainnet`

**Files:**
- Create on VM: `/etc/cloudflared/megaeth-mainnet.yml`
- Create on VM: `/etc/systemd/system/cloudflared-megaeth-mainnet.service`
- CF API call: CNAME `megaeth.ophis.fi → <UUID>.cfargotunnel.com`

- [ ] **Step 1: Create the named tunnel from the VM**

```bash
ssh -p <ssh-port> -i ~/.ssh/<deploy-key> root@REDACTED_ORIGIN_IP 'cloudflared tunnel create ophis-megaeth-mainnet'
```

Note the tunnel UUID returned.

- [ ] **Step 2: Write the tunnel config**

```yaml
# /etc/cloudflared/megaeth-mainnet.yml
tunnel: <UUID>
credentials-file: /root/.cloudflared/<UUID>.json
ingress:
  - hostname: megaeth.ophis.fi
    service: http://localhost:8104
  - service: http_status:404
```

- [ ] **Step 3: Write the systemd service**

```ini
# /etc/systemd/system/cloudflared-megaeth-mainnet.service
[Unit]
Description=Cloudflare Tunnel — ophis-megaeth-mainnet
After=network.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --config /etc/cloudflared/megaeth-mainnet.yml run
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now cloudflared-megaeth-mainnet
systemctl status cloudflared-megaeth-mainnet
```

- [ ] **Step 4: Create the CNAME**

```bash
# from Mac, with cloudflare-api-token from Keychain
TOKEN=$(security find-generic-password -l cloudflare-api-token -w)
ZONE=<ophis.fi zone ID from CF dashboard>
TUNNEL_UUID=<from Step 1>
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"CNAME\",\"name\":\"megaeth\",\"content\":\"$TUNNEL_UUID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
```

- [ ] **Step 5: Verify public endpoint**

```bash
curl -s https://megaeth.ophis.fi/api/v1/version
```

Expected: 200, version JSON.

### Task 7: Write smoke test (mirror of optimism)

**Files:**
- Create: `infra/megaeth-mainnet/scripts/smoke-test-e2e.ts`
- Create: `infra/megaeth-mainnet/scripts/package.json`
- Create: `infra/megaeth-mainnet/scripts/tsconfig.json`

- [ ] **Step 1: Generate test wallet + fund**

```bash
# Generate a fresh wallet
cast wallet new
# Save to keychain
security add-generic-password -U -a "$USER" -s ophis-megaeth-test \
  -w "<PRIVATE_KEY>"
# Fund: send 0.01 MEGA to the wallet's address from the deployer
```

- [ ] **Step 2: Mirror infra/optimism/scripts/smoke-test-e2e.ts to megaeth-mainnet**

Key differences from the optimism smoke test:
- `OPTIMISM_SEPOLIA` → `MEGAETH_MAINNET` constant (chain id 4326, RPC `mainnet.megaeth.com/rpc`)
- `GPV2_SETTLEMENT` → `OPHIS_SETTLEMENT_MAINNET` from env
- `ORDERBOOK_URL = 'https://megaeth.ophis.fi'`
- `VAULT_RELAYER` → query at runtime via `cast call $SETTLEMENT vaultRelayer()`
- Buy token: USDT0 instead of GTUSD
- **Pass on `status: fulfilled` with non-empty `txHash`** — no winning-solver fallback. Mainnet RPC has headroom.

Write the file as a near-verbatim copy of `infra/optimism/scripts/smoke-test-e2e.ts` with the deltas applied.

- [ ] **Step 3: Install deps**

```bash
cd infra/megaeth-mainnet/scripts && pnpm install --ignore-workspace
```

- [ ] **Step 4: Run smoke test**

```bash
cd infra/megaeth-mainnet/scripts
export MEGAETH_MAINNET_GTUSD=<the bootstrap pool's pair-buy-token; here USDT0 0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb>
export MEGAETH_MAINNET_TEST_WALLET_PK=$(security find-generic-password -l ophis-megaeth-test -w)
pnpm smoke
```

Expected: `✓ E2E settled, tx 0x<hash>` and `cast tx $hash` on chain.

- [ ] **Step 5: Commit smoke test**

```bash
git add infra/megaeth-mainnet/scripts/
git commit -m "feat(megaeth-mainnet): smoke test + scripts package"
```

### Task 8: Documentation + memory + telegram alerts

**Files:**
- Modify: `infra/cloudflare/ophis-chain-backends.md`
- Modify: `docs/development/specs/2026-05-12-spec-3-megaeth-mainnet.md` (mark SHIPPED)
- Modify: `/Users/scep/.claude/projects/-Users-scep/memory/project_greg.md`
- Modify: `apps/rebate-indexer/src/alerter.ts` (or extend existing alerter)

- [ ] **Step 1: Update runbook**

Add a megaeth-mainnet row to the "Useful constants" table; add a "MegaETH mainnet specifics" section noting:
- Public RPC handles load (no paid sub needed)
- Bootstrap pool is Ophis-deployed V2 WETH/USDT0
- Settlement contract at `0x0864b65F…Bfce` (CREATE2-deterministic across all Ophis chains)

- [ ] **Step 2: Mark Spec 3 SHIPPED**

```bash
# Edit docs/development/specs/2026-05-12-spec-3-megaeth-mainnet.md
# Add at top: "## Status: SHIPPED 2026-MM-DD"
```

- [ ] **Step 3: Update memory**

In `project_greg.md`, add a `megaeth-mainnet` row to the "Live chain stacks" list. Update the "Next" bullet to point at Spec 2 → Spec 4.

- [ ] **Step 4: Extend alerter for MegaETH mainnet driver balance**

Telegram alert when `cast balance 0x00f98b…502F --rpc-url https://mainnet.megaeth.com/rpc` returns less than 0.01 MEGA. Check every 6h. Same pattern as existing rebate-indexer alerter; this just adds one more balance check.

- [ ] **Step 5: Commit + PR + merge**

```bash
git add infra/cloudflare/ophis-chain-backends.md docs/development/specs/2026-05-12-spec-3-megaeth-mainnet.md apps/rebate-indexer/src/alerter.ts
git commit -m "docs(spec-3): MegaETH mainnet shipped + runbook + alerter"
git push origin <branch>
gh pr create --title "feat: Spec 3 — MegaETH mainnet backend live"
```

---

## Done definition

All Task 8 boxes checked PLUS:
- `pnpm smoke` reproducibly passes
- `cast tx <settlement>` on chain shows settlement is a real on-chain transaction
- Public endpoint `https://megaeth.ophis.fi/api/v1/version` resolves over HTTPS
- Telegram heartbeat fires successfully when artificially draining the driver balance below threshold (one-off test, then refill)
- PR merged to main

---

## Notes for the executor

- **Re-runnability:** Tasks 1-3 are one-shot (on-chain). Tasks 4-8 are repeatable; if anything fails, fix and retry. Use the operator runbook's per-chain restart procedures.
- **RPC trust:** `https://mainnet.megaeth.com/rpc` is verified 2026-05-12 to handle >30 RPS, batches, accessList. If load behavior degrades, see Spec 3's "Risk & rollback" table.
- **No nightly e2e CI:** Don't enable a Sepolia-style nightly here. Mainnet smoke is a one-shot run after each VM redeploy, not a CI cron — would cost real MEGA per night.
