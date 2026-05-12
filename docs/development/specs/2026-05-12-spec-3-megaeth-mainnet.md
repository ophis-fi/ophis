# Spec 3 — MegaETH mainnet backend

> Sequel to Spec 1 (testnet revival, shipped 2026-05-12). Spec 3 deploys the first **mainnet** Greg backend on MegaETH (chain ID 4326).

## Summary

Deploy Greg's CoW-based settlement stack to MegaETH mainnet:

1. Deploy the canonical CoW contracts (`GPv2Settlement`, `GPv2VaultRelayer`, `AllowListAuthentication`) under Greg's own deployer + salt — same CREATE2-deterministic address pattern as testnet (`0x0864b65F…Bfce`).
2. Deploy supporting contracts (`Balances`, `Signatures`, `HooksTrampoline`).
3. **Route through Kumbaya** — MegaETH's dominant DEX (~$53M TVL, UniswapV3 fork). No Greg V2 deploy. No bootstrap pool seeding. Greg routes orders through existing Kumbaya liquidity.
4. Stand up the CoW services stack (orderbook + autopilot + driver + baseline) as a new co-tenant on vm4 (`REDACTED_ORIGIN_IP:24014`).
5. Wire `megaeth.ophis.fi` via a new Cloudflare tunnel.
6. Smoke-test end-to-end with an actual on-chain settlement transaction (mainnet RPC has headroom for the broadcast, unlike Spec 1's testnet RPC).

## Goals & non-goals

### Goals
- Settle a real trade on MegaETH mainnet through Greg's self-hosted backend.
- Same operator surface as Spec 1 (co-tenant on vm4, single SSH, single Cloudflare account).
- Smoke test asserts on the settlement tx hash (not on winning-solver-only).
- Document costs end-to-end so Spec 2 (Optimism mainnet) has a price/complexity reference.

### Non-goals
- Frontend wiring (teaching `cowswap` fork to route MegaETH mainnet orders to `megaeth.ophis.fi`) — that's Spec 4.
- Integration with external MegaETH-native AMMs (Kumbaya, etc.) for richer liquidity — bootstrap pool is enough for day-1 proof.
- Optimism mainnet deploy — that's Spec 2.
- Token launch — never.
- Partner-fee receipt on this chain — already configured globally via the appData partner-fee shape; activation is automatic once orders flow.

## Why MegaETH mainnet first (before Optimism mainnet / Spec 2)

1. **Public RPC works.** `https://mainnet.megaeth.com/rpc` survives 30+ RPS sustained, batches up to ≥10, returns proper `eth_createAccessList` schema. No RPC subscription or self-hosted node needed (verified 2026-05-12).
2. **CoW Protocol does NOT serve MegaETH.** Unlike Optimism (already on CoW's official orderbook), MegaETH is unserved — there's no incumbent. First-mover advantage on intent-based DEX aggregation.
3. **Lower deploy cost.** Gas on a 3-month-old L1 is cheap; full Greg stack deploy is sub-$5 in mainnet MEGA tokens.
4. **Lower risk.** Spec 2's RPC-budget question (Hetzner self-host vs paid provider) is unresolved. Spec 3 has no dependency on that decision.

## Architecture

Co-tenant on the existing rebates VM, mirroring Spec 1's pattern:

```
                Aleph VM (REDACTED_ORIGIN_IP:24014)
                /srv/ophis/
                ├── apps/rebate-indexer/         [running]
                ├── infra/optimism/              [running, Spec 1]
                ├── infra/megaeth/               [running, Spec 1 — testnet]
                └── infra/megaeth-mainnet/       [NEW, this spec]
                       ↳ docker-compose.mainnet.yml
                       ↳ ports 8104/8105/9003/5436
                       ↳ Cloudflare Tunnel `ophis-megaeth-mainnet`
                                                       │
                                                       ▼
                                          megaeth.ophis.fi
```

**Port allocation** (reserved so far on vm4):
| Stack | orderbook | driver | baseline | db | tunnel |
|---|---|---|---|---|---|
| rebates | 8080 | — | — | — | `ophis-rebates` |
| optimism (Spec 1) | 8100 | 8101 | 9021 | 5434 | `ophis-optimism-sepolia` |
| megaeth-testnet (Spec 1) | 8082 | 8083 | 9001 | 5432 | `ophis-megaeth-testnet` |
| **megaeth-mainnet (this spec)** | **8104** | **8105** | **9003** | **5436** | **`ophis-megaeth-mainnet`** |

**Why a separate `infra/megaeth-mainnet/` and not extending `infra/megaeth/`.** Keeping testnet around lets us regression-test contract upgrades on testnet first. Spec 1 deferred the testnet decommission and that decision stays here — testnet stays warm.

## Components

Same 4-service Rust stack as Spec 1 (orderbook, autopilot, driver, baseline) + 1 Postgres + 1 migrations job. Image set is shared with the testnet stacks (`local-orderbook`, `local-autopilot`, `local-driver`, `local-baseline`, `backend-migrations`) — no rebuild needed.

**Per-service config diffs from Spec 1 megaeth-testnet:**
- `orderbook.toml` / `autopilot.toml` / `driver.toml` `node-url` and `simulation-node-url` → `https://mainnet.megaeth.com/rpc`
- `[contracts]` block addresses → the mainnet-deployed Greg contracts (filled post-deploy by `deploy-mainnet-all.sh`)
- `[[liquidity.uniswap-v3]]` (instead of v2) → Kumbaya UniswapV3Factory `0x68b34591f662508076927803c567Cc8006988a09` with **custom pool init-code-hash** `0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7` (Kumbaya forked V3 with a modified salt; differs from canonical UniV3's `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54`)
- chain ID env → `4326`
- explorer URL → `https://megaeth.blockscout.com/` (per Kumbaya kit; megaexplorer.xyz also works)

## On-chain deploy sequence

The existing `infra/megaeth/deploy/deploy-mainnet-all.sh` (written 2026-05-04) **needs modification** before running — its V2 factory/router deploy block must be commented out or removed for mainnet, since we route through Kumbaya now instead of a Greg-deployed V2 fork. The `seed-mainnet-pool.sh` script is no longer needed at all.

1. **Fund deployer wallet.** `0xb398C789F8690357e2b3D2ef6d1CDe62B1e4D020` needs ~0.05 mainnet MEGA for gas. Bridge in. **No pool-seed funding needed** (Kumbaya already has $53M TVL).
2. **Fund driver-submitter.** `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` needs ~0.05 mainnet MEGA for ongoing settlement gas.
3. **Modify `infra/megaeth/deploy/deploy-mainnet-all.sh`** — comment out section `[3/4] Deploying Uniswap V2` and renumber subsequent sections; remove the V2 entries from the address-append at the bottom. Commit the change.
4. **Run the modified `deploy-mainnet-all.sh`** — deploys:
   - CoW core: `GPv2Settlement`, `GPv2VaultRelayer`, `GPv2AllowListAuthentication` (via hardhat-deploy / `hardhat-megaeth.config.ts`)
   - CoW helpers: `Balances`, `Signatures`, `HooksTrampoline` (via `cast send --create`)
   - Allowlists driver-submitter as solver
   - Appends addresses to `infra/megaeth/.env` under `GREG_*_MAINNET` keys.

After step 4 the on-chain side is done. Step 5+ is backend infra.

## VM deploy sequence

5. **Create `infra/megaeth-mainnet/` from a copy of `infra/megaeth/`** (just the runtime infra; not the deploy/v2-artifacts dirs). Port-remap inside `docker-compose.mainnet.yml` to `8104/8105/9003/5436`.
6. **Configure** `infra/megaeth-mainnet/configs/{autopilot,driver,orderbook}.toml` with mainnet addresses + mainnet RPC.
7. **`rsync -az infra/megaeth-mainnet/ aleph-greg:/srv/ophis/infra/megaeth-mainnet/`** (use `/opt/homebrew/bin/rsync`, the openrsync that ships on macOS rejects `--exclude` globs).
8. **On VM:** `docker compose -f docker-compose.mainnet.yml up -d` (env loads from `.env` in cwd, no `--env-file` override).
9. **Create named Cloudflare tunnel** `ophis-megaeth-mainnet`: `cloudflared tunnel create`, write `/etc/cloudflared/megaeth-mainnet.yml`, write `/etc/systemd/system/cloudflared-megaeth-mainnet.service`, `systemctl enable --now`.
10. **Add CNAME** `megaeth.ophis.fi → <UUID>.cfargotunnel.com` via CF API token. **Single-level subdomain** — `api.megaeth.ophis.fi` would need paid Advanced Certificate Manager (per the Spec 1 lesson).

## Smoke test (the actual gate)

`infra/megaeth-mainnet/scripts/smoke-test-e2e.ts` adapted from the Optimism Sepolia smoke test:
- Sign EIP-712 manually with `verifyingContract = GREG_SETTLEMENT_MAINNET`, `chainId = 4326`
- Submit via raw `fetch` to `https://megaeth.ophis.fi/api/v1/orders`
- Poll `/api/v1/orders/$UID` and `/api/v1/trades?orderUid=$UID`
- **Exit 0 only on `status: fulfilled` with a real `txHash`** — no winning-solver fallback. Mainnet RPC has headroom; broadcast must succeed.

Test parameters: 0.001 WETH → some target buy amount of a major Kumbaya-listed token. At execution time, query Kumbaya's deepest WETH-pair on-chain (or via the integrator-kit) and pick that. Likely candidates per the integrator kit: WETH/USDC, WETH/USDT — confirm at run-time.

Pre-condition: a separate `greg-megaeth-test` Keychain entry with a funded test wallet (0.001 ETH + 0.001 WETH minimum). Wallet to be created during execution.

## Risk & rollback

| Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|
| MegaETH mainnet RPC degrades after deploy | Low | Pipeline halts, no settle | Public RPC has been stable since 2026-02-09 launch (3 months). Monitor via `/health`-equivalent. | Spin up a self-hosted MegaETH replica node on Hetzner (~€30/mo, 4-8 cores per docs) as a hot standby. |
| Bootstrap pool too thin → all orders slip badly | Medium | Bad UX, no fills | Seed with ≥ $3k AT LAUNCH. Monitor TVL. | Add more liquidity (deployer keeps a reserve). |
| Settlement contract address collides with existing user funds on MegaETH | Very low | Catastrophic | CREATE2 with our salt is mathematically unique to our deployer; no other deployment can land there. | N/A. |
| Driver-submitter EOA drains gas | Medium | Settlement stalls until refill | Auto-alert via Telegram (extend Spec 1's alerter to also watch MegaETH balance every 6h). | Refill from deployer wallet. |
| New CoW services version breaks our deploy pattern | Low | Image rebuild fails | Image set is pinned to the rev currently built on vm4 (Spec 1 ship). | Stay on pinned rev until tested. |
| WETH/USDT0 token contracts on MegaETH have unexpected behavior (fee-on-transfer, rebase, etc.) | Low | Solver computes wrong amounts | Use token-integration-analyzer skill (Trail of Bits weird-token catalog) against both before pool-seeding. | Don't seed if pathological; swap to a different stable. |

## Cost breakdown

| Item | Cost |
|---|---|
| MegaETH mainnet gas (deploys + allowlist) | ~$5 in mainnet MEGA |
| MegaETH mainnet gas (driver settlement, ongoing) | ~$0.01/tx, refilled as-needed |
| Infrastructure (vm4 co-tenant) | $0 incremental (existing VM with 9 GiB free memory headroom) |
| Cloudflare tunnel + DNS | $0 (within existing free-tier limits) |
| RPC provider | $0 (public `mainnet.megaeth.com/rpc`) |
| Bootstrap liquidity | **$0** (route through Kumbaya's existing $53M TVL) |
| **Total recurring monthly** | **$0** |
| **One-time setup** | **~$5 gas, no pool seed** |

## Success metrics + done-checklist

### Live state on the VM
- [ ] `docker ps` shows `megaeth-mainnet-{orderbook,autopilot,driver,baseline,db}-1` all running
- [ ] `megaeth-mainnet-db-1` healthy
- [ ] no `429`/`rate limit`/`MalformedRequest` errors in `optimism-driver-1` or `megaeth-mainnet-driver-1` logs over a 10-minute window

### Public endpoints
- [ ] `https://megaeth.ophis.fi/api/v1/version` returns 200 with the service version JSON
- [ ] `https://megaeth.ophis.fi/api/v1/quote` (POST with valid quote params) returns a quote
- [ ] TLS valid, CF Universal SSL covers single-level subdomain

### End-to-end smoke test (the actual gate)
- [ ] `pnpm smoke` from `infra/megaeth-mainnet/scripts/` exits 0 with `✓ E2E settled, tx 0x<hash>`
- [ ] `cast tx <hash> --rpc-url https://mainnet.megaeth.com/rpc` confirms the settlement landed on chain
- [ ] order's `executedBuyAmount > 0` in the API response
- [ ] Etherscan-equivalent on megaexplorer.xyz shows the settlement contract call

### Repo state
- [ ] `infra/megaeth-mainnet/` exists with docker-compose + configs + scripts
- [ ] all mainnet addresses in `infra/megaeth/.env` under `GREG_*_MAINNET` keys (not committed; gitignored locally + on VM)
- [ ] operator runbook `infra/cloudflare/ophis-chain-backends.md` extended with the third-chain table row + a "MegaETH mainnet specifics" section

### Documentation
- [ ] `project_greg.md` `## Phase 3.5 — Aleph VM hosting` section gets a megaeth-mainnet row in the live-chain-stacks list
- [ ] this spec marked `## Status: SHIPPED <date>`

### Telegram alerts
- [ ] Extend `apps/rebate-indexer/src/alerter.ts` (or co-located alerter) to send a Telegram message on first successful mainnet settlement
- [ ] Heartbeat checks ophis-megaeth-mainnet tunnel + driver-submitter gas balance every 6h

### Negative checks (must NOT happen)
- [ ] No exposure of `infra/megaeth/.env` (contains deployer PK references) to any committed path
- [ ] No deploy-script execution against `mainnet.megaeth.com/rpc` from a CI runner — deploy is always operator-driven from Clement's Mac

## Open questions for implementation plan

1. **Token choices for the bootstrap pool.** WETH + USDT0 from the deploy scripts, or swap USDT0 for something more liquid on MegaETH? Pending: research which stablecoin has the deepest market on MegaETH at deploy time.
2. **Pool initial price.** Set by amounts seeded; need an explicit target. Currently script uses 80% of wallet balance. Should we cap at a USD value (e.g. exactly $1,500 of each side) instead?
3. **Deployer wallet bridge route.** Cheapest path to get MEGA mainnet ETH into `0xb398…D020`? Stargate / Across / native MegaETH bridge.
4. **Test-wallet funding source.** New Keychain entry `greg-megaeth-test` or reuse deployer? Reusing is simpler; conflicts if seed-pool tx and smoke-test tx race on the nonce. Recommend new wallet.

The implementation plan should resolve 1-4 inline and then enumerate the per-step tasks from "fund wallets" → "smoke green".
