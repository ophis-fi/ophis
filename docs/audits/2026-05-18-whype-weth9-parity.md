# WHYPE ↔ WETH9 Parity Audit (HIGH-2 follow-up)

**Date:** 2026-05-18
**Scope:** Hyperliquid's Wrapped HYPE contract at `0x5555555555555555555555555555555555555555` vs canonical WETH9 at `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (Ethereum mainnet)
**Audit context:** Phase 1 audit HIGH-2 — Ophis EthFlow assumes WHYPE matches WETH9 semantics on multiple paths (constructor `approve(MAX)`, `wrap()` via bare payable call, `withdraw()` in refund path) AND backend Spardose simulator assumes balance lives at storage slot 3.

## Summary

**WHYPE is functionally WETH9-equivalent for every behavior EthFlow + Spardose depend on.** Bytecode is NOT identical (smaller, different implementation), but the ABI surface and storage layout match exactly where it matters.

| Test | Expected (WETH9 behavior) | Actual (WHYPE) | Verdict |
|---|---|---|---|
| `name()` | "Wrapped Ether"-style | "Wrapped HYPE" | ✓ string returns |
| `symbol()` | "WETH"-style | "WHYPE" | ✓ |
| `decimals()` | `18` | `18` | ✓ |
| `totalSupply()` | uint256 | `6.545M HYPE` | ✓ |
| Bare `.call{value:N}("")` (fallback) | Triggers deposit, mints WHYPE | Tx `0x2c87f359…`: balance 0 → 1 wei | ✓ |
| Explicit `deposit()` payable | Mints WHYPE | Tx `0xd95faac9…`: balance 0 → 2 wei | ✓ |
| `approve(spender, amount)` | Returns `true`, sets allowance | Tx `0xb2572c89…`: allowance 0 → 12345 | ✓ |
| `withdraw(uint256)` | Burns WHYPE, sends native | Tx `0xb62f09ba…`: WHYPE 1 wei → 0, native balance increased | ✓ |
| `balanceOf(address)` matches storage slot 3 | Mapping at slot 3 | HyperSwap V3 pool: storage `0x2a3ae10917ccc016c75` = `12464094934681358789749` = `balanceOf()` exactly | ✓ |

## What differs from canonical WETH9

| Property | WHYPE | Canonical WETH9 | Impact |
|---|---|---|---|
| Codehash | `0xe2e18bc11f218432ca1aabc44b53cce54a78c77ae2d76093a577e0564a77aa04` | `0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23` | Different implementation. Not a hot-swap concern (WHYPE has no upgrade path on HL). |
| Runtime bytecode size | 2,042 bytes | 3,125 bytes | WHYPE is ~33% smaller. Likely solc 0.8+ compiled with optimizer + fewer redundant overloads. Behavior tests still pass. |

The bytecode difference does **not** affect any path EthFlow or Spardose touch. WHYPE simply omits unused parts of the legacy WETH9 source while preserving the canonical ABI + storage layout.

## Confirmed audit assumptions

1. **`infra/hyperevm-mainnet/configs/orderbook.toml.tmpl` Spardose config** (`map_slot = "0x3"` for WHYPE) → **VALID**. Balance mapping is at slot 3 confirmed across 3 holder addresses.
2. **`apps/cowswap-frontend/.../CoWSwapEthFlow.sol:46` constructor `WHYPE.approve(VaultRelayer, MAX_UINT256)`** → **VALID**. approve returns true; allowance writes correctly.
3. **`CoWSwapEthFlow.sol:62-73` `wrap()` low-level `.call{value: amount}("")`** → **VALID**. Bare payable fallback wraps native into WHYPE.
4. **`CoWSwapEthFlow.sol:230-236` `_invalidateOrder` refund path `withdraw(uint256)`** → **VALID**. Unwrap returns native to caller.

## Open items / defense-in-depth

- **Telegram alert on EthFlow `EthTransferFailed` event** (audit recommendation): added to `infra/hyperevm-mainnet/observability/alerts.yml` as `OphisHlEthFlowTransferFailed`. Will fire if any refund path reverts at the `payable(orderData.owner).call{value: refundAmount}` step.
- **Codehash freeze**: WHYPE has no documented upgrade mechanism on HL (no proxy slot detected), but a hypothetical chain-system upgrade could theoretically replace it. Pin the current codehash `0xe2e18bc1…aa04` in this doc; if `cast keccak (cast code 0x5555…5555)` ever changes, re-run all 9 tests above.

## Test artifacts (HL mainnet txs)

All sent from driver-submitter `0xFB30…1bB5a` on chain 999:

- Bare-call deposit (1 wei): `0x2c87f359762094f3b03653bd1e29e7eca06d46f3d3d91a7be34234e927bfa95f`
- Explicit `deposit()` (2 wei): `0xd95faac936d4cd997b6d9553f6f6988a0c434de8866bc4464ebbf65053c159be`
- `approve(0xdEAD…42, 12345)`: `0xb2572c89e34ac3111b7ad1eb8a7f76594880f9d600a17b2889bdbf91cfaf1fc8`
- `withdraw(1)`: `0xb62f09baba14d7177e5734e03222e0b5786c6d322218dd1d2a3f64a771c11dd5`

Total cost: <0.001 HYPE.

## Verdict

**HIGH-2 audit finding: CLOSED**. WHYPE is functionally WETH9-equivalent for every behavior Ophis depends on. The audit's risk was speculative ("not formally audited as such"); empirical testing confirms the surface contracts match expectations.

Residual operational risk: defensive `OphisHlEthFlowTransferFailed` alert installed as canary.
