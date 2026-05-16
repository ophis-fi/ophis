# Project X subgraph — HyperEVM mainnet

This indexer backs the Ophis baseline solver's UniswapV3-style liquidity source for **Project X** (the $165 M/24h CL DEX on HL with no public subgraph). Phase 2 of the V3 wiring spec at `docs/development/specs/2026-05-16-hl-uniswap-v3-liquidity.md`.

## Why this exists

- The CoW driver's `[[liquidity.uniswap-v3]]` block requires a subgraph URL.
- Project X has the highest TVL of any HL DEX but no public subgraph (verified 2026-05-16).
- So we self-index, queryable via the standard UniV3 schema the CoW driver expects.

## Architecture

Deliberately minimal — the CoW driver only queries:

```graphql
pools {
  id
  token0 { id symbol decimals }
  token1 { id symbol decimals }
  feeTier liquidity sqrtPrice tick
}
ticks { id tickIdx liquidityNet poolAddress }
```

So we skip USD prices, day data, position tracking, fee accounting, and all the other fields the canonical Uniswap V3 subgraph maintains. Expected indexing speed: ~10× the canonical Uniswap subgraph. Expected storage: ~5× smaller.

| File | Purpose |
|---|---|
| `subgraph.yaml` | Manifest — pins factory `0xff7b…b072`, startBlock `7876741`, network `hyperevm`. |
| `schema.graphql` | Pool, Token, Tick entities (5 + 4 + 6 fields each). |
| `src/factory.ts` | Handles PoolCreated → creates Pool + Token entities, spawns Pool template. |
| `src/pool.ts` | Handles Initialize / Swap / Mint / Burn → maintains slot0-equivalent state + tick liquidityNet/Gross. |
| `abis/Factory.json` | Canonical IUniswapV3Factory ABI (extracted from `apps/backend/contracts/artifacts/`). |
| `abis/Pool.json` | Canonical UniswapV3Pool ABI (same source). |
| `abis/ERC20.json` | Minimal ERC-20 (name/symbol/decimals/totalSupply). |
| `package.json` | graph-cli scripts + Goldsky CLI deploy + self-hosted graph-node deploy. |

## Deploy paths

You have two options. Pick one — they're not mutually exclusive, but running both costs more than the benefit.

### Path A — Goldsky (recommended for Phase 2)

**Why:** zero infra to maintain; free tier covers our usage (1.5 M GraphQL queries/mo, our expected load <50k/mo); reliable indexing for HL is Goldsky's day job.

**Cost:** $0 on free tier. Escape path is the $49/mo Standard tier (10 M queries) or self-host (Path B).

**One-time setup (you do this):**

```bash
# 1. Sign up at https://app.goldsky.com (GitHub OAuth — no card needed for free tier).
# 2. Install the CLI on the Mac mini:
curl https://goldsky.com | sh
# 3. Authenticate:
goldsky login
#    → opens a browser, click "Authorize Goldsky CLI" in your dashboard.
# 4. Verify:
goldsky --version  # should print something
```

**Deploy from this directory:**

```bash
cd infra/hyperevm-mainnet/subgraphs/project-x/
npm install
npm run codegen
npm run build
npm run deploy:goldsky
#    → prompts for slug + version (defaults are fine), then deploys.
#    → outputs the GraphQL endpoint URL — copy it.
```

**Wire it into the driver:**

After deploy, Goldsky gives you a URL like `https://api.goldsky.com/api/public/<project-id>/subgraphs/project-x-hl/0.0.1/gn`. Set it in the HL `.env`:

```bash
echo 'PROJECT_X_SUBGRAPH_URL=https://api.goldsky.com/api/public/.../project-x-hl/0.0.1/gn' >> infra/hyperevm-mainnet/.env
```

…then add a **second** `[[liquidity.uniswap-v3]]` block to `infra/hyperevm-mainnet/configs/driver.toml.tmpl` (the Phase 1 PR templated `HYPERSWAP_V3_SUBGRAPH_URL` — Phase 2 does the same for `PROJECT_X_SUBGRAPH_URL`). That edit is in the **follow-up PR** that lands after Goldsky deploy is confirmed working.

**Indexing time estimate:**
- Project X factory deployed at block `7876741`, current block ~`35.3 M` → backlog of ~27.4 M blocks.
- Goldsky indexes HL at ~10 k blocks/min sustained.
- **Estimated full sync: ~46 hours.**

You can start serving queries against the partial index well before full sync (the driver gracefully tolerates pools that aren't indexed yet — they'll surface lazily as the indexer catches up).

### Path B — Self-hosted graph-node on an Aleph VM

**Why:** full sovereignty, no third-party dependency, no rate limits. **Costs:** ~$50/mo Aleph VM + ops time (~4h initial setup + ongoing maintenance).

**Setup outline (not a runbook — needs adaptation):**

```bash
# On Aleph VM (separate from the existing mcp-services / allo VMs):
docker compose -f - up -d << 'EOF'
version: "3.8"
services:
  graph-node:
    image: graphprotocol/graph-node:latest
    ports:
      - "8000:8000"  # GraphQL HTTP
      - "8020:8020"  # JSON-RPC for management
      - "8030:8030"  # subgraph health
    environment:
      postgres_host: postgres
      postgres_user: graph-node
      postgres_pass: ${POSTGRES_PASSWORD:?}
      postgres_db: graph-node
      ipfs: ipfs:5001
      ethereum: "hyperevm:https://rpc.purroofgroup.com"
      GRAPH_LOG: info
  ipfs:
    image: ipfs/kubo:latest
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: graph-node
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
      POSTGRES_DB: graph-node
EOF
```

**Then deploy from the developer machine:**

```bash
cd infra/hyperevm-mainnet/subgraphs/project-x/
npm install
npm run codegen
npm run build
npm run deploy:selfhost:create  # one-time, registers the subgraph name
GRAPH_NODE_URL=http://<aleph-vm-ip>:8020 \
GRAPH_IPFS_URL=http://<aleph-vm-ip>:5001 \
npm run deploy:selfhost:deploy
```

The endpoint will be `http://<aleph-vm-ip>:8000/subgraphs/name/project-x-hl/graphql`. Expose via Cloudflare Tunnel like the rest of the Ophis backend.

**Caveat:** graph-node needs an archive node (for `eth_call` at historical blocks) for the first full sync. `rpc.purroofgroup.com` is full-node-only — sync will fail at `Mint`/`Burn`-driven token reads if it tries to `eth_call` at the event block. You'll either need:
- A paid HL archive RPC, OR
- Patch the mappings to skip historical token-info reads and lazy-load on first query.

**Don't pick Path B unless you've decided Goldsky is unacceptable for reasons not yet documented.** Path A is plug-and-play for HL.

## Test plan after deploy

```bash
# Health
curl "$URL" -X POST -H "Content-Type: application/json" \
  -d '{"query":"{ _meta { block { number timestamp } hasIndexingErrors } }"}'

# Pool count
curl "$URL" -X POST -H "Content-Type: application/json" \
  -d '{"query":"{ pools(first:1, orderBy: createdAtBlock) { id } pools_aggregate: pools(first: 1000) { id } }"}'

# Top liquidity pools (canonical CoW driver query shape)
curl "$URL" -X POST -H "Content-Type: application/json" \
  -d '{"query":"{ pools(first:10, orderBy: liquidity, orderDirection: desc, where:{tick_not:null}) { id token0{symbol id decimals} token1{symbol id decimals} feeTier liquidity sqrtPrice tick } }"}'

# Per-tick liquidityNet (for a known busy pool — replace with a real id)
curl "$URL" -X POST -H "Content-Type: application/json" \
  -d '{"query":"{ ticks(first:5, where:{poolAddress:\"0x...\"}) { id tickIdx liquidityNet poolAddress } }"}'
```

## What this PR does NOT do

- **Deploy the subgraph.** Authoring only. Deploy is your call (Path A or B).
- **Add a second `[[liquidity.uniswap-v3]]` block in `driver.toml.tmpl`.** That edit lands in a follow-up PR once Goldsky returns the actual endpoint URL — until then there's nothing to put there.
- **Add Prometheus alerting for subgraph staleness.** Once deployed, we'll add an `OphisHlProjectXSubgraphStale` rule using Goldsky's `/health` endpoint (or graph-node's `/subgraphs/health` for self-host).

## Validation done before PR

| Check | Result |
|---|---|
| Project X factory bytecode at `0xff7b…b072` | 48249 bytes (canonical UniV3Factory + extensions); `feeAmountTickSpacing(uint24)` returns `1/10/60/200` for fees `100/500/3000/10000` |
| `PoolCreated` event topic | `0x783cca1c…b7118` matches canonical UniV3 signature |
| Factory deployment block | `7876741` (found via binary search on `rpc.purroofgroup.com`) |
| Recent PoolCreated logs | Two pools created in the last ~5000 blocks — factory is active |
| `factory()` resolves on Pool template ABI | yes — UniswapV3Pool ABI extracted from `apps/backend/contracts/artifacts/UniswapV3Pool.json` (26 ABI entries) |
| ABI events PoolCreated/Initialize/Swap/Mint/Burn | all present in extracted ABIs |
