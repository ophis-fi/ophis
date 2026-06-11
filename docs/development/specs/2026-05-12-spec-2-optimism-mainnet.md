# Spec 2 — Optimism mainnet backend

> Sequel to Spec 1 + parallel to Spec 3. Spec 2 deploys Ophis's first **production-grade** mainnet backend: Optimism mainnet (chain ID 10), routed through real Uniswap V3 liquidity.
>
> **BLOCKED by Spec 5** (Pre-mainnet security hardening). No mainnet contract deploys until Spec 5 ships hardware-wallet flow + Safe ownership of AllowListAuthentication.

## Summary

1. Deploy the canonical CoW contracts on Optimism mainnet using Ophis's deployer + salt (same CREATE2-deterministic address as testnet: `0x0864b65F…Bfce`).
2. Deploy CoW supporting contracts (`Balances`, `Signatures`, `HooksTrampoline`).
3. **Do NOT deploy a Ophis V2 factory** — configure the CoW baseline solver to route liquidity through **Uniswap V3** on OP mainnet (canonical 0.05% WETH/USDC.e pool has deep liquidity). Velodrome V2 — OP's dominant DEX (~99% of OP V2-style TVL) — is *not* a candidate for this spec: our forked CoW solver supports `uniswap-v2`, `swapr`, `uniswap-v3`, `balancer-v2`, `0x` — but not Velodrome's Solidly-style pools. Adding that adapter is a ~1-2 day Rust task scoped to Spec 5.
4. Stand up the CoW services stack as a co-tenant on vm4 (or a new dedicated host, see Architecture Branch A/B/C below).
5. Wire `optimism.ophis.fi` via a new Cloudflare tunnel.
6. Smoke-test end-to-end with an actual WETH→USDC settlement against real Velodrome liquidity.

## Goals & non-goals

### Goals
- Settle a real trade on Optimism mainnet through Ophis's self-hosted backend with the partner-fee shape (CIP-75) live.
- Resolve the RPC-hosting question raised by Spec 1 (free public RPCs can't handle CoW driver pressure).
- Validate that the CoW stack routes correctly through external (Velodrome V2) liquidity, not just Ophis-deployed test pools.
- Document the operational delta between testnet (Spec 1) and mainnet — gas, RPC, real liquidity, alerting.

### Non-goals
- MegaETH mainnet — that's Spec 3.
- Frontend wiring — Spec 4.
- Integration with Optimism's other DEXs (Velodrome V3 / Aerodrome / Curve) for richer liquidity — bootstrap with Velodrome V2 only; expand in Spec 5.
- Migration of existing testnet/Spec 1 stacks off vm4 — separate cleanup spec.
- CoW Protocol coexistence concerns — Optimism is already on CoW's official orderbook. Ophis's orderbook competes; both run in parallel without sharing state.

## Why Optimism mainnet matters separately from MegaETH

| | MegaETH mainnet (Spec 3) | Optimism mainnet (Spec 2) |
|---|---|---|
| CoW Protocol native support | None — unserved chain | Yes, full coverage |
| Ophis's positioning | First-mover on intent-based DEX agg | Differentiated alternative (better UX, partner-fee structure) |
| Real on-chain liquidity | Sparse, must bootstrap with our own pool | Deep, integrate Velodrome V2 |
| RPC | Public RPC handles our workload | All free RPCs fail under CoW driver pressure |
| Risk profile | Mostly contract-deploy risk | RPC operational risk + competing against incumbent |

## Architecture — Branch A (Aleph Cloud) locked 2026-05-12

Branch A locked: Clement is Aleph's CMO; compute on Aleph is free for him. Spec 2 hosts the op-node + op-geth pair on a new Aleph VM (or single-VM-co-located with the chain stack — implementation plan picks). The three-branch matrix below is preserved as decision-record context for future infra moves.

## Architecture branches (decision record only)

### Branch A: Aleph Cloud (RECOMMENDED if Clement gets CMO pricing)

```
                          Aleph VM (NEW: vm-greg-op-mainnet)
                          16 GB RAM / 8 vCPU / 1 TB NVMe
                          ├── op-node (consensus)
                          └── op-geth (execution)
                                ↑
                                │ HTTP localhost:8545
                                │
   Aleph VM (vm4.alephvision.eu, EXISTING)
   REDACTED_ORIGIN_IP:<ssh-port>
   └── infra/optimism-mainnet/   [NEW: this spec]
         orderbook + autopilot + driver + baseline + db
         node-url = http://<vm-greg-op-mainnet.internal>:8545
                                                       ↓
                                          optimism.ophis.fi
```

**Cost (assumed):** Free or near-free with Clement's CMO standing on Aleph. Recurring marginal cost ≈ $0.

**Why this is the strongest option:**
- Free if Clement's allocation covers it
- Unified ops (same Aleph console, same SSH key, same Cloudflare)
- The op-node + op-geth pair only needs ~1-2 RPS to follow L1, served by free public Ethereum RPCs (`eth.llamarpc.com`, `cloudflare-eth.com`); zero subscription cost for L1
- Existing rebate-indexer + Spec 1 stacks stay where they are

**Risks specific to this branch:**
- Aleph VM uptime SLA (verify before deploy)
- Aleph internal networking between vm4 and the new op-node VM (Tailscale, or Aleph private mesh?)
- Disk attachment mechanism for 1TB NVMe — needs confirmation from Aleph console

### Branch B: Hetzner Auction self-host

```
                    Hetzner Auction box (NEW)
                    16+ GB RAM / 4+ vCPU / 1+ TB NVMe
                    ├── op-node (consensus)
                    ├── op-geth (execution)
                    └── infra/optimism-mainnet/   [migrated from vm4 plan]
                          orderbook + autopilot + driver + baseline + db
                                                       ↓
                                          optimism.ophis.fi
```

**Cost:** €30-50/mo recurring (no setup fee on auction boxes), one-time setup time ~1 day.

**Why this:** Strongest sovereignty. Zero rate limits. Cheap. Hardware long-lasting (10y+).

**Risks specific to this branch:**
- Single point of failure unless paired with a second box
- Hetzner Datacenter does have multi-day outages occasionally
- Need credit card on file with Hetzner (Clement-side decision)

### Branch C: Alchemy Growth ($49/mo)

```
   Aleph VM (vm4)
   └── infra/optimism-mainnet/
         orderbook + autopilot + driver + baseline + db
         node-url = https://opt-mainnet.g.alchemy.com/v2/<paid-key>
                                                       ↓
                                          optimism.ophis.fi
```

**Cost:** $49/mo. Recurring forever.

**Why this:** Fastest to ship — no infrastructure setup. 660 CUPS is enough headroom for the CoW driver. Zero ops.

**Risks specific to this branch:**
- Vendor lock-in
- Cost scales with usage (Growth's overage pricing applies past 660 CUPS sustained)
- Clement said "I don't want to pay alchemy for an rpc node" — only included for completeness

### Decision matrix

| | Branch A (Aleph) | Branch B (Hetzner) | Branch C (Alchemy) |
|---|---|---|---|
| Recurring cost | ~$0 | €30-50/mo | $49/mo |
| Setup time | ~4hr (provision + sync) | ~1 day | ~5 min |
| Ops burden | Low (Aleph console handles infra) | Medium (Linux ops on bare metal) | Zero |
| Sovereignty | Medium | High | Low |
| Rate-limit risk | Low (we own the RPC) | Zero | Low (660 CUPS) |
| Single-tenant cleanliness | Med (depends on co-tenant load) | High | N/A (vendor's problem) |
| **Recommendation** | **First choice** | Second choice | Tie-breaker only |

The implementation plan must close on one branch before execution.

## On-chain deploy sequence (host-independent)

1. **Fund Optimism mainnet deployer wallet.** Likely a new wallet (`ophis-optimism-deployer` Keychain entry) since `0xb398…D020` is the MegaETH deployer and we don't want cross-chain nonce confusion. Funded with ~0.05 OP-mainnet ETH (~$1.50 at OP gas prices).
2. **Fund driver-submitter EOA on Optimism mainnet.** Same `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F`; needs ~0.05 OP-mainnet ETH for ongoing settlement gas.
3. **Run `infra/optimism/deploy/deploy-mainnet-all.sh`** (to be written, mirrored from `infra/megaeth/deploy/deploy-mainnet-all.sh` Spec 3 pattern):
   - CoW core via hardhat-deploy with `hardhat-optimism.config.ts`
   - CoW helpers via `cast send --create`
   - Allowlists driver-submitter on the AuthList
   - **No** Ophis V2 deploy — Velodrome V2 is the liquidity source
   - Appends `OPHIS_*_OP_MAINNET` keys to `infra/optimism/.env`
4. **Verify Velodrome V2 access** — call `factory()` on the Velodrome V2 router; sanity-check it returns the expected Velodrome factory address.

## VM deploy sequence (Branch A example; Branch B differs at step 5-7)

5. **Provision new Aleph VM** `vm-greg-op-mainnet` with 8 vCPU / 16 GB / 1 TB NVMe. Same Aleph CLI flow Clement used for vm4. Hostname + SSH endpoint TBD.
6. **Install op-node + op-geth** via the official `optimism-node` docker-compose. Sync from snapshot (~12-24h).
7. **Verify the new node** — `curl localhost:8545` reports the current OP mainnet block, syncing complete (`eth_syncing` returns `false`).
8. **Set up private routing** between vm4 and the new node. Options:
   - Tailscale (preferred — works across Aleph instances)
   - Cloudflare Tunnel from new node, expose internal-only endpoint
   - Aleph private mesh if supported
9. **Create `infra/optimism-mainnet/`** from `infra/optimism/` (no testnet leakage). Port allocation `8102/8103/9022/5435` (next free after Spec 1's optimism-sepolia `8100/8101/9021/5434`).
10. **Configure** `infra/optimism-mainnet/configs/{autopilot,driver,orderbook}.toml`:
    - `node-url` + `simulation-node-url` → `http://<tailscale-hostname>:8545`
    - `[contracts]` → mainnet-deployed addresses
    - `[[liquidity.uniswap-v3]]` → Uniswap V3 factory on Optimism `0x1F98431c8aD98523631AE4a59f267346ea31F984`, subgraph URL `https://api.thegraph.com/subgraphs/name/ianlapham/optimism-post-regenesis` (verify still up before plan-write) or self-hosted subgraph alternative
    - chain ID env → `10`, explorer → `https://optimistic.etherscan.io`
11. **`rsync` to vm4** + `docker compose up -d` (same pattern as Spec 1).
12. **Cloudflare tunnel** `ophis-optimism-mainnet`, CNAME `optimism.ophis.fi → <UUID>.cfargotunnel.com`. Single-level subdomain per the Spec 1 lesson.

## Smoke test

`infra/optimism-mainnet/scripts/smoke-test-e2e.ts`. Same pattern as Spec 3 (settlement-tx assertion), but:
- Buys USDC (not USDT0; OP mainnet has native USDC at `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`)
- Sells 0.001 WETH
- Routes through Velodrome V2 (whatever pool the baseline solver picks)
- Expects `executedBuyAmount ≈ 3.8 USDC` (matches ETH-USD spot)
- Exits 0 only on `status: fulfilled` with a real `txHash`

Pre-condition: a separate `ophis-optimism-test` Keychain entry with ≥0.001 OP-mainnet ETH + ≥0.001 WETH.

## Risk & rollback

| Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|
| op-node sync stalls past 24h | Medium | Spec blocked | Use a known-good snapshot URL from Optimism's docs page. Allow 36h. | Switch to a different snapshot or temporary Branch C. |
| Uniswap V3 subgraph rate-limits or goes down | Medium | Solver can't discover pools | Self-host the subgraph on the same VM. ~2-4h additional ops. | Fallback to a hardcoded pool address list. |
| L1 RPC rate-limits (op-node's call rate to L1 Ethereum) | Low | Sync stalls, driver stalls | Use a list of 3-4 free L1 RPCs (`eth.llamarpc.com`, `cloudflare-eth.com`, `ethereum.publicnode.com`, `1rpc.io/eth`) with round-robin in op-node config. | Add a paid L1 endpoint if needed. |
| Driver-submitter EOA runs dry on Optimism mainnet gas | Medium | Settlement stops | Telegram heartbeat checks balance every 6h, alerts < 0.01 ETH | Refill from deployer wallet. |
| Velodrome V2 liquidity insufficient for the buy amount | Low | Order doesn't fill | Test with small amounts (0.001 WETH) initially. | Use larger amounts only after demonstrated success. |
| OP mainnet hard fork breaks op-node/op-geth | Medium (semi-annual) | Driver halts | Subscribe to Optimism release notifications; maintenance window. | Update op-node + op-geth, re-sync. |

## Cost breakdown

| Item | Branch A (Aleph) | Branch B (Hetzner) | Branch C (Alchemy) |
|---|---|---|---|
| OP mainnet gas (one-time deploys) | ~$2 | ~$2 | ~$2 |
| OP mainnet gas (settlement, ongoing) | ~$0.001/tx | same | same |
| Self-hosted node infra | ~$0 (Aleph CMO) | €30-50/mo | N/A |
| L1 follow-RPC | $0 (free public) | $0 (free public) | N/A |
| Alchemy subscription | N/A | N/A | $49/mo |
| **Total recurring monthly** | **~$0** | **€30-50** | **$49** |
| **One-time setup** | **~$2 gas + 4hr** | **~$2 gas + 1 day** | **~$2 gas + 5 min** |

## Success metrics + done-checklist

### Live state on the VM
- [ ] `docker ps` on vm4 shows `optimism-mainnet-*` services running
- [ ] (Branch A only) New Aleph VM running op-node + op-geth, synced
- [ ] No `429`/`rate limit` errors in `optimism-mainnet-driver-1` logs over a 10-minute window

### Public endpoints
- [ ] `https://optimism.ophis.fi/api/v1/version` returns 200
- [ ] `https://optimism.ophis.fi/api/v1/quote` (POST) returns a real Velodrome-backed quote

### End-to-end smoke test (the actual gate)
- [ ] `pnpm smoke` from `infra/optimism-mainnet/scripts/` exits 0 with `✓ E2E settled, tx 0x<hash>`
- [ ] `cast tx <hash> --rpc-url <our-rpc>` confirms settlement on chain
- [ ] order's `executedBuyAmount > 0`
- [ ] Etherscan link in smoke output goes to optimistic.etherscan.io

### Repo state
- [ ] `infra/optimism-mainnet/` exists with docker-compose + configs + scripts + deploy/
- [ ] all mainnet addresses in `infra/optimism/.env` under `OPHIS_*_OP_MAINNET` keys
- [ ] operator runbook extended with optimism-mainnet row + Branch A/B/C decision recorded

### Telegram alerts
- [ ] Alerter watches driver-submitter gas balance on Optimism mainnet every 6h
- [ ] Alerter notifies on first successful mainnet settlement

### Negative checks (must NOT happen)
- [ ] No commit of any `*_PK` env var to the repo
- [ ] No deploy-script execution against `mainnet.optimism.io` from CI
- [ ] No exposure of the op-node RPC endpoint to the public internet (must be private/tailnet only)

## Open questions for implementation plan

1. **Branch choice (A/B/C).** ~~Pending~~ **Locked: Branch A (Aleph) 2026-05-12.**
2. **Uniswap V3 subgraph reliability + fallback strategy.** Verify The Graph hosted subgraph still serves the OP V3 subgraph; if not, self-host or list pools statically.
3. **L1 RPC for op-node.** Pick a primary + 2-3 fallbacks. Configure round-robin.
4. **Snapshot source for op-geth initial sync.** Use Optimism's official snapshot URL (TBD which one) or a third-party (Quicknode, dwellir).
5. **Test wallet provisioning.** Generate `ophis-optimism-test` Keychain entry; fund via the deployer.
6. **Network topology in Branch A.** Tailscale tailnet, Aleph private mesh, or CF Tunnel internal hostname? Pick before plan-write.

The implementation plan should resolve 1-6 inline and then enumerate per-step tasks from "fund wallets" → "smoke green".
