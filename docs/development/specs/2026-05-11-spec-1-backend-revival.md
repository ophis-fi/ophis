# Spec 1 — Backend revival + Linea cleanup

**Status:** Approved (brainstorm), ready for implementation plan
**Author:** Clement
**Date:** 2026-05-11
**Series:** Phase 4 — Sovereign-orderbook on non-CoW chains. Spec 1 of 3:
1. **Spec 1 (this doc) — Backend revival** on the rebates VM, validate end-to-end on Optimism Sepolia testnet
2. **Spec 2 — Sovereign Optimism mainnet** — deploy contracts + go live
3. **Spec 3 — Sovereign MegaETH mainnet** — public launch moment with brand attached

---

## Summary

The Phase 3 Aleph VM that hosted Ophis's Rust services (orderbook + autopilot + driver + baseline solver) for multi-chain testnet validation is dead — the IP at `REDACTED_ORIGIN_IP_OLD:24019` no longer accepts TCP connections. Phase 3's testnet contracts on Optimism Sepolia, MegaETH testnet, and Linea Sepolia are still on-chain (bytecode-verified at `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce`), but the backend that served orderbook traffic against them is gone.

Spec 1 revives the backend by co-tenanting the chain stacks onto the *existing* rebates VM (`vm4.alephvision.eu`, REDACTED_ORIGIN_IP:<ssh-port>), drops `infra/linea/` since CoW Protocol serves Linea natively, and validates the revival end-to-end with a real settled order on Optimism Sepolia. **No new contracts. No new wallets. No real ETH spent.** The deliverable is a working backend template that Specs 2 and 3 promote to mainnet.

## Goals & non-goals

**Goals.**
- Two chain stacks (Optimism Sepolia, MegaETH testnet) running on the rebates VM, each with 4 Rust services + Postgres
- Two named Cloudflare Tunnel subdomains: `optimism-sepolia.ophis.fi`, `megaeth-testnet.ophis.fi`
- Programmatic end-to-end smoke test: sign + submit order → on-chain settlement observed on Optimism Sepolia
- `infra/linea/` removed from the tree; Linea variants removed from `apps/backend/`
- Phase 3 validation doc annotated to reflect new VM + Linea drop
- Rebate-indexer continues to serve `rebates.ophis.fi` uninterrupted during and after the revival

**Non-goals (Spec 1).**
- No mainnet contract deployment on any chain — that's Spec 2/3
- No frontend wiring — the cowswap fork continues to use `api.cow.fi/<chain>` for the 10 CoW-supported chains; our new backends are only reachable via direct API calls in Spec 1
- No fee structure changes — testnet has no fees that matter
- No HA / failover / multi-VM resilience — single-VM single-point-of-failure is acceptable for Spec 1; reliability hardening is post-Spec-3
- No MegaETH testnet on-chain settlement — known sequencer bug (`Cannot read properties of undefined (reading 'length')` on EIP-1559 settlement) is upstream's issue. MegaETH stack validates only as far as `driver simulated OK`; Optimism Sepolia is the canonical end-to-end gate
- No Aleph VM provisioning — reuse the existing rebates VM at `vm4.alephvision.eu`

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │     Aleph VM (vm4.alephvision.eu)           │
                    │     REDACTED_ORIGIN_IP:<ssh-port>  ssh root@…         │
                    │     existing rebates-indexer co-tenant      │
                    │                                              │
                    │  /srv/ophis/          (existing repo rsync) │
                    │  ├── apps/rebate-indexer/    [running]      │
                    │  │     ↳ Caddy :80 → indexer:8080 (rebates) │
                    │  │     ↳ Cloudflare Tunnel `ophis-rebates`  │
                    │  ├── infra/optimism/        [NEW: revived]  │
                    │  │     ↳ docker-compose.testnet.yml         │
                    │  │     ↳ ports 8100/8101/9021/5434          │
                    │  │     ↳ Cloudflare Tunnel `ophis-optimism-sepolia` │
                    │  └── infra/megaeth/         [NEW: revived]  │
                    │        ↳ docker-compose.testnet.yml         │
                    │        ↳ ports remapped 8082/8083/9001/5432  │
                    │        ↳ Cloudflare Tunnel `ophis-megaeth-testnet` │
                    └─────────────────────────────────────────────┘
                              │              │              │
                              ▼              ▼              ▼
                    rebates.ophis.fi   optimism-        megaeth-
                       (exists)        sepolia.ophis.fi  testnet.ophis.fi
                                          (new)             (new)
```

**Co-tenancy rationale.** The rebates VM has 8 vCPU / 16 GB / 160 GB. Rebate-indexer uses ~1 GB. Two chain stacks each consume ~3 GB → 7 GB total of 16. Plenty of headroom. Single SSH context, single Cloudflare account, single set of credentials.

**Port allocation.** `infra/optimism/docker-compose.testnet.yml` uses `8100/8101/9021/5434` — no conflict with the rebate-indexer on `8080`. `infra/megaeth/docker-compose.testnet.yml` originally used `8080/8081` — **must be remapped to `8082/8083`** before deploy or it collides with the rebate-indexer. Internal Postgres ports (`5432`) are container-network-scoped, no collision.

**Why programmatic E2E, not frontend-integrated.** Spec 1 validates "the backend can produce a settled trade on Optimism Sepolia." Frontend wiring (teaching the cowswap fork to route Optimism Sepolia orders to `optimism-sepolia.ophis.fi` instead of CoW's URL) is Spec 2 scope. Separate surfaces, separate validations.

## Components

Four Rust services per chain (vendored from `cowprotocol/services` via the `apps/backend/` subtree), each in its own Docker container. Plus a Postgres per chain. Same shape Phase 3 used.

```
Per chain (× 2 chains: optimism-sepolia, megaeth-testnet):

┌─────────────────────────────────────────────────────────────┐
│ postgres:16-alpine                                          │
│   ↳ stores orders, trades, solver competitions              │
│   ↳ schema applied via `backend-migrations` (Flyway)        │
└─────────────────────────────────────────────────────────────┘
        ▲
        │ R/W
┌───────┴─────────────────┐   ┌──────────────────────────────┐
│ orderbook               │   │ autopilot                    │
│   ↳ Axum HTTP API       │   │   ↳ polls orderbook for      │
│   ↳ accepts signed      │   │      open orders             │
│      orders, returns    │◀──┤   ↳ assembles batch          │
│      quotes             │   │   ↳ dispatches to driver     │
│   ↳ listens 8082/8100   │   │      via internal HTTP       │
└───────┬─────────────────┘   └──────┬───────────────────────┘
        │                            │
        │ /api/v1/orders             │ POST /solve
        │ (HTTP, external)           │ (HTTP, internal)
        ▼                            ▼
   Caddy :80                  ┌──────────────────────────────┐
        │                     │ driver                       │
        │                     │   ↳ takes batch, calls       │
        │                     │      baseline solver         │
        ▼                     │   ↳ simulates settlement     │
   cloudflared                │   ↳ signs + submits tx       │
        │                     │      with driver-submitter   │
        ▼                     │      EOA                     │
   Cloudflare network         │   ↳ listens 8083/8101        │
        │                     └──────┬───────────────────────┘
        ▼                            │
   <chain>.ophis.fi              │ POST /solve
                                     ▼
                              ┌──────────────────────────────┐
                              │ baseline solver              │
                              │   ↳ Rust crate "baseline"    │
                              │   ↳ V2/V3 path-finding       │
                              │   ↳ routes through deployed  │
                              │      Uniswap-V2 fork pools   │
                              │      (seeded WETH/GTUSD)     │
                              │   ↳ listens 9001/9021        │
                              └──────────────────────────────┘
```

| Service | Container image | Role | External? |
|---|---|---|---|
| `orderbook` | local-orderbook | HTTP API surface; signed orders + quotes + order state | ✅ via Caddy + tunnel |
| `autopilot` | local-autopilot | Per-block loop; batches open orders, dispatches solving | ❌ internal-only |
| `driver` | local-driver | Calls each solver, picks winner, signs settlement with driver-submitter EOA, submits to chain | ❌ internal-only |
| `baseline` | local-baseline | The only solver we run. Path-finds through configured V2/V3 pools | ❌ internal-only |
| `postgres` | postgres:16-alpine | All four services share one DB per chain | ❌ internal-only |
| `backend-migrations` | from `apps/backend/Dockerfile target=migrations` | Flyway schema apply; runs to completion then exits | ❌ |

**Config files per chain** (already exist from Phase 3, in `infra/<chain>/configs/`):

- `orderbook.toml` — DB URL, chain ID, settlement contract address, native-price source
- `autopilot.toml` — submission timing, driver URL, solver-uses-internal-balances flag
- `driver.toml` — submitter EOA PK (env-injected), settlement + vault-relayer addresses, DEX presets (the `[[liquidity.uniswap-v2]]` block pointing at OUR deployed V2 fork's factory + init-code-hash)
- `baseline.toml` — base tokens, solver URL (self), max routing hops

**Key existing artifacts being revived (no re-deploy):**

- Ophis's testnet `GPv2Settlement` at `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` (Optimism Sepolia + MegaETH testnet — bytecode verified)
- Ophis's `GPv2VaultRelayer` at `0x842F655C9310C32e5932A0eBFa80c4Cd358c0205` (CREATE2-deterministic same address)
- Ophis's Uniswap V2 fork + seeded WETH/GTUSD pools on each testnet (factory addresses captured in each `infra/<chain>/.env.example`)
- Driver-submitter EOA `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` (key in macOS Keychain `<keychain-service>`), already on Ophis's `AllowListAuthentication` allowlist on each chain

## Revival sequence

Six stages, each gated. Re-runnable.

```
Stage A: Cleanup + prep         (~30 min)
  ├─ git rm -r infra/linea/
  ├─ Drop Linea variants from apps/backend/crates/chain/src/lib.rs
  ├─ Remap megaeth ports (8080→8082, 8081→8083) in
  │  infra/megaeth/docker-compose.testnet.yml
  └─ Annotate docs/development/phase-3-validation.md to reflect
     "Linea dropped (CoW native)" + "VM migrated to vm4 co-tenancy"

Stage B: Code transfer          (~5 min)
  ├─ rsync apps/backend/ + infra/{optimism,megaeth}/ from local
  │  to /srv/ophis on the rebates VM
  └─ Verify .env.example files have the right addresses

Stage C: Build images           (~15-20 min cold, ~2 min warm)
  ├─ On VM: docker compose -f infra/optimism/docker-compose.testnet.yml build
  │  ↳ builds: local-orderbook, local-autopilot, local-driver,
  │           local-baseline, backend-migrations
  ├─ Then same for infra/megaeth/
  └─ Note: first build is ~15 min (cargo build --release of the
     entire CoW services workspace). Layer cache shared between
     the two chains since same source.

Stage D: Boot stacks            (~3 min each)
  ├─ Inject driver-submitter PK from Keychain → VM env
  ├─ docker compose -f infra/optimism/docker-compose.testnet.yml \
  │    --env-file infra/optimism/.env up -d
  ├─ Watch logs for orderbook starting + migrations applying
  ├─ Same for infra/megaeth/
  └─ docker compose ps to confirm all containers Up + healthy

Stage E: Tunnel + DNS           (~15 min)
  ├─ For each chain, on the VM:
  │   cloudflared tunnel create ophis-<chain>-testnet
  ├─ Config file at /etc/cloudflared/<chain>.yml with ingress:
  │   - hostname: <chain>-testnet.ophis.fi
  │     service: http://localhost:<orderbook_port>
  │   - service: http_status:404
  ├─ Install as separate systemd unit:
  │   cloudflared service install --config /etc/cloudflared/<chain>.yml
  ├─ Cloudflare API: create CNAME <chain>-testnet → <UUID>.cfargotunnel.com
  └─ Verify: curl -fsS https://optimism-sepolia.ophis.fi/api/v1/version

Stage F: E2E smoke test         (~30 min)
  ├─ CLI script (in infra/optimism/scripts/smoke-test-e2e.sh):
  │  1. Mint test tokens to a test wallet
  │  2. Approve VaultRelayer on test tokens
  │  3. Sign a WETH→GTUSD order with the cow-sdk
  │  4. POST to optimism-sepolia.ophis.fi/api/v1/orders
  │  5. Poll order status until "fulfilled"
  │  6. Verify settlementTxHash on Optimism Sepolia explorer
  │  7. Output: ✓ E2E passed in Xs, settlement tx <hash>
  ├─ MegaETH testnet smoke test: same script but expect to
  │  stop at "simulated" (not "fulfilled") due to the known
  │  sequencer guard bug. Treat as "ok within constraints".
  └─ Once Optimism Sepolia returns ✓ → Spec 1 complete
```

**Idempotency.** Every stage is re-runnable. The compose `restart: always` policy means re-running `docker compose up -d` after edits is a rolling restart, not double-boot. Postgres volumes persist; we don't lose order history. The smoke-test CLI uses fresh order UIDs and can run repeatedly.

## Risk & rollback

Spec 1 is fully reversible at the cost of an afternoon — **no on-chain state changes**. Worst-case revert: `docker compose down -v` per chain, `cloudflared tunnel delete <UUID>` per tunnel, delete the CF DNS records, `git revert` the Stage A commit. ~10 commands, 5 minutes. Rebate-indexer, the frontend, and the testnet contracts are unaffected.

| Risk | Likelihood | Impact | Mitigation | Recovery |
|---|---|---|---|---|
| Rust build fails (toolchain drift) | Medium | Stage C blocked | Pin to `.greg-upstream` SHA `0720b9bc1…`; the Rust toolchain file in `apps/backend/` matches. Fall back to rsync local `target/` cache. | Skip Spec 1, revert Stage A. |
| Rebate-indexer disrupted by co-tenancy | Low | Live production service degraded | Apply Docker `mem_limit: 2g` per chain backend service + Postgres `max_connections=50`. Rebates uses ~1 GB; chain backends ~3 GB each = 7 of 16. | If rebates `/health` fails: `docker compose down` per chain stack. Rebates recovers automatically. |
| Driver-submitter EOA underfunded on Optimism Sepolia | Medium | Stage F settlement reverts | Pre-check `cast balance 0x00f98b…502F --rpc-url https://sepolia.optimism.io`. Top up from `eury-deployer` if < 0.05 SEP ETH. | Top up + retry. |
| Optimism Sepolia testnet state reset | Very low | Contracts gone, Spec 1 invalid | Already verified `cast code` returns bytecode this session. | Re-deploy via `infra/optimism/deploy/` scripts. ~$0 testnet cost. |
| MegaETH testnet sequencer bug persists | High (known) | Stage F MegaETH stops at simulation | Pre-documented in Phase 3 validation. Accept; gate Spec 1 on Optimism Sepolia only. | None needed. |
| Tunnel cert.pem auth fails | Low | Stage E blocked | `cert.pem` already on VM at `/root/.cloudflared/cert.pem` (from earlier rebates work). | Re-scp from local. |
| Cloudflare DNS API perm gap | Low | Stage E blocked | CF_TOKEN already exercised on `rebates.ophis.fi`. | Same path. |
| Docker network name collision | Low | Stage D `compose up` fails | Each compose stack's default network namespace = directory name. | Set `name: <chain>-testnet-net` explicitly if it ever collides. |

**Acceptable risks (not mitigated):**
- Rust cold build ~15 min. Once-per-VM cost.
- MegaETH testnet stops at "driver simulated OK" — upstream bug, mainnet has different code path per Phase 3 docs.
- No HA / failover on a single VM. Spec 1 is revival, not bulletproofing.

## Success metrics + done-checklist

Spec 1 is **done** when every box below is checked, observable from the operator's terminal, and reproducible by anyone with SSH to the VM.

### Live state on the VM (`REDACTED_ORIGIN_IP:<ssh-port>`)
- [ ] `docker compose -f infra/optimism/docker-compose.testnet.yml ps` shows 5 containers running + healthy (orderbook, autopilot, driver, baseline, postgres; migrations exited 0 once)
- [ ] Same for `infra/megaeth/docker-compose.testnet.yml`
- [ ] `docker compose -f apps/rebate-indexer/docker-compose.yml ps` still shows rebate-indexer healthy
- [ ] `free -h` shows ≥ 4 GB free under both chain stacks

### Public endpoints
- [ ] `curl -fsS https://optimism-sepolia.ophis.fi/api/v1/version` returns 200 with CoW orderbook version JSON
- [ ] Same for `https://megaeth-testnet.ophis.fi/api/v1/version`
- [ ] `dig +short optimism-sepolia.ophis.fi @1.1.1.1` returns Cloudflare proxy IPs (104.x or 172.67.x)
- [ ] `dig +short CAA optimism-sepolia.ophis.fi @1.1.1.1` inherits the `ophis.fi` CAA records (no per-subdomain CAA needed)

### End-to-end smoke test (the actual gate)
- [ ] `infra/optimism/scripts/smoke-test-e2e.sh` runs to completion, signs an order with a test wallet, posts to `optimism-sepolia.ophis.fi/api/v1/orders`, polls until status `fulfilled`, prints `✓ E2E passed, settlement tx 0x<hash>`
- [ ] The reported tx hash resolves on the Optimism Sepolia explorer and shows a successful `settle()` call on `0x0864b65F…Bfce`
- [ ] The order's `fullAppData.metadata.appCode` reads `"ophis"`
- [ ] Re-running the smoke test from a fresh shell, fresh order UID, on the same day succeeds → reproducibility check

### MegaETH testnet partial validation
- [ ] `infra/megaeth/scripts/smoke-test-e2e.sh` reaches the documented `driver simulated OK` log line, then the known sequencer-guard error blocks final tx submission. Captured as expected.

### Repo state
- [ ] `infra/linea/` deleted from git
- [ ] `apps/backend/crates/chain/src/lib.rs` no longer has `LineaSepolia` enum variant
- [ ] `apps/backend/crates/liquidity-sources/src/lib.rs` cleaned of Linea arm
- [ ] `docs/development/phase-3-validation.md` annotated with Linea-dropped + VM-migration notes
- [ ] Commits follow conventional-commit style (`feat(infra)`, `chore(infra)`, `docs(phase-3)`)

### Documentation
- [ ] New runbook at `infra/cloudflare/ophis-chain-backends.md` covering: SSH path, per-container log locations, single-chain restart procedure without affecting others, "how to add a third chain" template
- [ ] Memory `project_greg.md` updated so `## Phase 3.5 — Aleph VM hosting` reflects vm4 co-tenancy

### Telegram alerts
- [ ] Bot sends `🟢 chain backend revived` once both stacks return 200 on `/api/v1/version`. Reuses `apps/rebate-indexer/src/telegram/alerter.ts`.

### Negative checks (must NOT happen)
- [ ] `rebates.ophis.fi/health` still returns `{ok: true}` after revival
- [ ] Frontend at `ophis.fi` continues routing 10 CoW-supported chain orders through `api.cow.fi` (Spec 1 does not touch frontend wiring)
- [ ] No new contracts deployed on any chain
- [ ] No real ETH spent

### Spec 1 deliverables for handoff to Spec 2
1. The VM has 4 Rust services × 2 chains = 8 containers proven to coexist with rebate-indexer
2. The compose-file pattern + cloudflared tunnel pattern + DNS naming convention are templates ready to replicate for the Optimism + MegaETH **mainnet** stacks in Spec 2
3. The smoke-test script is the regression test we re-run after Spec 2's mainnet deploy
4. The MegaETH-testnet-sequencer bug is documented as "mainnet has different code path; expect it to work" — testable in Spec 3 but not retroactively a Spec 1 concern

## Open questions for implementation plan

These don't need answering before coding starts but the writing-plans phase will resolve them:

- Concrete shape of the `smoke-test-e2e.sh` script (Bash + cast + jq vs TypeScript + cow-sdk). The cow-sdk approach is closer to how a real client would sign; bash + cast is faster to write.
- Whether to add a `--exit-non-zero-on-megaeth-fail` flag to the MegaETH smoke test so CI can distinguish "MegaETH expected-failure" from "MegaETH new-failure".
- Memory-limit numbers (`mem_limit: 2g` is a starting guess; might need tuning based on what cargo-built binaries actually consume at idle).
- Cloudflared multi-tunnel-per-VM hygiene: 3 systemd units (`cloudflared.service` + 2 new) or one `cloudflared-config.yml` with multiple ingresses. The plan should pick + document.
- Whether to back up the Postgres volumes daily to a cheap S3 bucket. Not strictly Spec 1 scope but tempting to bundle since we're touching ops.
