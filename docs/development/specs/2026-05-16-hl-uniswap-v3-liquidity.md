# HL UniswapV3 liquidity wiring — design spec

**Status**: Draft — addresses verified, implementation deferred to next session.
**Owner**: Clement / Claude (autonomous).
**Task**: #120. Supersedes #114 (which was scoped as a generic "wire V2/V3").
**Precondition**: Task #118 (observability stack) deployed + validated.
**Date**: 2026-05-16.

---

## Goal

Give the Ophis HL stack direct UniswapV3-style liquidity, so:

1. The baseline solver (currently removed in PR #46 because no V2 liquidity routed) can return real solutions.
2. The KyberSwap aggregator is no longer a single point of failure for HL routing — direct on-chain liquidity is a fallback when KyberSwap is rate-limited or down.
3. We can route through the dominant HL CL pools (Project X = $165 M/24h, HyperSwap V3 = $13 M/24h, Hybra V3 = $0.6 M/24h) at the protocol level, not just via an aggregator.

## Non-goals

- Hybra V4 wiring (custom CLFactory ABI; not UniV3-compatible at the factory layer — separate spec).
- Direct routing on OP / MegaETH — they already have OKX + KyberSwap + (now) Velora; V3 direct routing is a later upgrade.
- A new solver shape. Baseline already understands UniV3 once liquidity is exposed.

## Verified factory & periphery addresses (chain 999)

All addresses below confirmed by independent agent research (2026-05-16) — `cast code` returns substantial bytecode, `feeAmountTickSpacing(500)` returns `10`, and `slot0() / liquidity() / token0() / token1() / fee()` all expose the canonical UniV3 ABI.

### HyperSwap V3 — TIER 1 (drop-in, public subgraph)

| Role | Address | Notes |
|------|---------|-------|
| UniswapV3Factory | `0xB1c0fa0B789320044A6F623cFe5eBda9562602E3` | 24351 bytes. `feeAmountTickSpacing(500)=10` ✓ |
| NonfungiblePositionManager | `0x6eDA206207c09e5428F281761DdC0D300851fBC8` | 24384 bytes. `factory()` → factory ✓ |
| SwapRouter (V1) | `0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D` | 12070 bytes |
| **SwapRouter02** | `0x6D99e7f6747af2cdbb5164b6dd50e40d4fde1e77` | 21792 bytes. **Use this** in driver config. |
| QuoterV2 | `0x03a918028f22d9e1473b7959c927ad7425a45c7c` | 8365 bytes. Use for off-chain price queries. |
| Subgraph | `https://api.subgraph.ormilabs.com/api/public/33c67399-d625-4929-b239-5709cd66e422/subgraphs/hyperswap-v3/v0.1.2/gn` | Ormi-hosted (Goldsky-equivalent). |
| Fee tiers | `[100, 500, 3000, 10000]` (tickSpacings 1, 10, 60, 200) | Vanilla UniV3 set. |

### Project X (PRJX) — TIER 2 (drop-in pool ABI, NO public subgraph)

| Role | Address | Notes |
|------|---------|-------|
| UniswapV3Factory | `0xff7b3e8c00e57ea31477c32a5b52a58eea47b072` | 24123 bytes. `feeAmountTickSpacing(500)=10` ✓ |
| NonfungiblePositionManager | `0xead19ae861c29bbb2101e834922b2feee69b9091` | 24384 bytes. `factory()` → factory ✓ |
| SwapRouter | `0x1EbDFC75FfE3ba3de61E7138a3E8706aC841Af9B` | 12070 bytes |
| Quoter (V1) | `0x239f11a7a3e08f2b8110d4ca9f6b95d4c8865258` | 8273 bytes |
| Subgraph | **none publicly indexed** — would need to self-host on Goldsky / Ormi / The Graph hosted-service replacement | Highest-volume HL DEX ($165 M/24h) → most valuable to wire. |
| Fee tiers | `[100, 500, 3000, 10000]` | Vanilla UniV3 set. |

### Hybra V3 — TIER 2 (drop-in pool ABI, NO public subgraph)

⚠️ **Important correction**: the address `0x32b9dA73215255d50D84FeB51540B75acC1324c2` we used previously is **Hybra V4**, not V3. The V4 CLFactory has dynamic fees, no `feeAmountTickSpacing()`, and a non-standard `allPools(uint)` enumeration — it is NOT a drop-in UniV3 factory. The real Hybra **V3** factory is `0x2dC0Ec0F0db8bAF250eCccF268D7dFbF59346E5E`.

| Role | Address | Notes |
|------|---------|-------|
| UniswapV3Factory | `0x2dC0Ec0F0db8bAF250eCccF268D7dFbF59346E5E` | 24198 bytes. `feeAmountTickSpacing(500)=10` ✓ |
| NonfungiblePositionManager | `0x934c4f47b2d3ffca0156a45deb3a436202af1efa` | 22965 bytes |
| SwapRouter | `0x7db3d09ff3b398a771d0e2cde8ac612941c9e801` | 9880 bytes |
| QuoterV2 | `0x9aaa88ddd409c015f3ab3f557d3b138ec3cd66c0` | 6935 bytes |
| Subgraph | **none publicly indexed** | $0.6 M/24h (low). Wire after Project X. |
| Fee tiers | `[100, 500, 3000, 10000]` | Vanilla UniV3 set. |

### Hybra V4 — TIER 3 (needs custom adapter)

`CLFactory` at `0x32b9dA73215255d50D84FeB51540B75acC1324c2`. Pool ABI is UniV3-compatible (`slot0()`, `liquidity()`, etc.) — only the factory's pool registry is non-standard: `allPools(uint256)` enumeration, no `getPool(token0, token1, fee)`, and per-pool `fee()` (dynamic, no factory-level fee-tier list).

The CoW driver's UniV3 liquidity source assumes the factory has `getPool` + `feeAmountTickSpacing`. To support Hybra V4 we'd need either:
- A custom Hybra V4 liquidity-source variant in `apps/backend/crates/liquidity-sources/src/`, OR
- A thin shim that pre-enumerates pools via `allPools` and exposes a pseudo-`getPool` to the existing UniV3 source.

Either way: separate spec, separate session. Defer.

## CoW driver schema constraints

The driver's `UniswapV3` liquidity source struct (see `crates/driver/src/infra/liquidity/config.rs`):

```rust
pub struct UniswapV3 {
    pub router: eth::ContractAddress,
    pub max_pools_to_initialize: usize,
    pub graph_url: Url,                // *** subgraph required ***
    pub reinit_interval: Option<Duration>,
    pub max_pools_per_tick_query: usize,
}
```

`graph_url` is **not optional**. The pool-fetcher (`crates/liquidity-sources/src/uniswap_v3/pool_fetching.rs`) reads tick liquidity and pool list from the subgraph at startup, not on-chain.

**Implication**: Only HyperSwap V3 can be wired drop-in (TIER 1). Project X + Hybra V3 require either:
1. Self-hosted subgraph (Goldsky / Ormi / our own indexer) — operational lift but reuses CoW code unchanged.
2. New on-chain pool-enumeration path in the driver (Rust dev) — bypasses subgraph dependency entirely.

## Implementation plan (deferred to dedicated session)

### Phase 1 — HyperSwap V3 (drop-in)

1. Re-add `baseline` solver block to `infra/hyperevm-mainnet/configs/driver.toml.tmpl`. (Reverses PR #46 removal — now baseline has liquidity to route.)
2. Re-add `baseline:` service to `docker-compose.yml`.
3. Re-add `baseline` driver to `autopilot.toml.tmpl` + `orderbook.toml.tmpl`.
4. Add `[[liquidity.uniswap-v3]]` block to `driver.toml.tmpl`:
   ```toml
   [[liquidity.uniswap-v3]]
   router = "0x6D99e7f6747af2cdbb5164b6dd50e40d4fde1e77"   # HyperSwap SwapRouter02
   graph-url = "https://api.subgraph.ormilabs.com/api/public/33c67399-d625-4929-b239-5709cd66e422/subgraphs/hyperswap-v3/v0.1.2/gn"
   max-pools-to-initialize = 200
   max-pools-per-tick-query = 100
   ```
5. Pre-merge validation:
   - Probe subgraph: `curl -X POST <graph-url> -d '{"query":"{pools(first:5){id token0{symbol} token1{symbol} feeTier liquidity}}"}'` — confirm responsive + returns >100 pools.
   - Build driver image locally with the change, run against HL fork, confirm baseline returns a solution for WHYPE→USD₮0.
6. Post-deploy:
   - Watch `OphisHlSettlementFailureRateHigh` alert for 24h. Roll back if it fires.
   - Inspect `solutions{solver="baseline"}` — should be non-zero within 1h.

### Phase 2 — Project X (needs subgraph)

Open question: **does Project X have a private indexer we can request access to?** Their site (prjx.com) has no public docs. Twitter @prjx_hl might have a partner DM. Worth asking before self-hosting.

Fallback: deploy our own Project X subgraph on Goldsky:
- Manifest derived from their UniV3-fork ABI (their factory's bytecode is structurally identical to canonical UniV3Factory; same events).
- Cost: Goldsky free tier covers ~1M queries/mo; sufficient for our volume.
- Deploy time: 1-2h.

### Phase 3 — Hybra V3 (needs subgraph)

Same path as Phase 2. Lower priority due to volume ($0.6 M/d).

### Phase 4 — Hybra V4 (custom adapter, separate spec)

Out of scope of this spec. Tracked separately.

## Risk + observability checklist

Direct-liquidity wiring exposes new operational risks:

| Risk | Mitigation | Alert |
|------|------------|-------|
| Subgraph indexer goes down → pool list goes stale → settlement reverts | Self-host subgraph (Phase 2 onwards). HyperSwap V3 (Phase 1) relies on Ormi — accept the SPOF for the smaller pool. | `OphisHlSettlementFailureRateHigh` |
| Pool state drift (subgraph indexed before reorg, on-chain reorg'd) | `reinit-interval = "1h"` in driver config to force periodic full refresh. | `OphisHlSolverDropRateHigh` |
| Factory address typo lets attacker register a malicious pool | Hardcoded factory addresses (this spec) — no operator override. Verified bytecode. | n/a (constant-time defense) |
| eRPC quota saturation from V3 polling | Reduce `max-pools-to-initialize` to 50 if RPC error rate spikes. | `OphisHlERPCDown` + `OphisHlAuctionLatencyHigh` |

**All four mitigations rely on Prometheus alerts from task #118**, which is why #118 is a hard precondition.

## References

- Research agent report (2026-05-16): factory bytecode probes + ABI tests on each candidate DEX.
- DefiLlama HyperEVM L1 DEX overview: https://defillama.com/dexs/chain/hyperliquid-l1
- CoW driver UniV3 source: `apps/backend/crates/driver/src/infra/liquidity/config.rs:UniswapV3`
- CoW pool fetcher: `apps/backend/crates/liquidity-sources/src/uniswap_v3/pool_fetching.rs`
- HyperSwap V3 docs: https://docs.hyperswap.exchange/hyperswap/hyperswap-amm (note: `docs.hyperswap.pro` is outdated and has wrong addresses — use `.exchange` only)
- Hybra audit confirming UniV3-compatible pool ABI: `github.com/code-423n4/2025-10-hybra-finance`
- CIP-75 partner-fee model (relevant for partner-fee composition decisions): apps/frontend/src/cowswap-frontend/src/ophis/partnerFeeDefault.ts
