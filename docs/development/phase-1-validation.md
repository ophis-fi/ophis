# Phase 1 — Validation Log

## Stage 1: Forked Gnosis (no real money)

**Date:** 2026-05-02
**Trader:** 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (anvil account[0])
**Pair:** wxDAI → GNO, sell 0.1 wxDAI
**Order UID:** 0xa29a95b0740d976dbb6a1d18f76af5ae37fe04908696100204b667abff76a7f1f39fd6e51aad88f6f4ce6ab8827279cfffb9226669f68a90
**Settlement tx (anvil fork):** 0xf14d97563aaa1745e59242c99a317b281999b15b5858ed9f93436866c2e61cb1
**Block number (on fork):** 45975344
**Time-to-settle (signed → fulfilled):** ~31 seconds
**Stage 1 verdict:** PASS

### Notes / deviations from original plan

- The first attempt failed because upstream playground configs were mainnet-targeted (chain-id=1, mainnet token addresses). Task 7 fixed `baseline.toml`, `driver.toml`, and any other Gnosis-relevant fields, also switched the Uniswap-V2 preset to `honeyswap` (the canonical Gnosis fork uses Honeyswap's init code hash, not Uniswap's). After the fix, 17 AMMs of liquidity were sourced and settlement worked.
- We use `partiallyFillable: true` and a 20% slippage floor for permissive testnet/forked-chain conditions.

---

## Stage 2: Sepolia (real chain, $0 cost — pivoted from Gnosis mainnet)

**Date:** 2026-05-03
**Why Sepolia, not Gnosis mainnet:** Phase 1 budget was zero. Sepolia has CoW deployed at the same address (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`, 32KB code), Phase 0 left funded wallets there, and the production-shape stack (no anvil) tests identical code paths to Gnosis. The only deviation is chain-specific config (chain-id, base-tokens, DEX preset).

**Stack:** `docker-compose.sepolia.yml` — 6 services, no anvil, real Sepolia RPC (`ethereum-sepolia.publicnode.com`).
**Trader:** `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` (Phase-0 reuse — already has WETH + relayer-approved)
**Driver-submitter:** `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` (funded 0.1 ETH from eury-deployer, tx `0x2ebec0b5f5c531240f8b66292d280c5ca98d33d4f3359ec200a21ef479593188`)
**Pair quoted:** WETH → COW (Sepolia)
**Order submitted:** `0x0230d85c19703b6d44b12cf06200366334141cfca054c55ae86f161093b79d5d412cbcce46fcba707a3190eced8113bbc2c294ab69f72117` (HTTP 201 accepted)
**Settlement tx:** NOT SETTLED (see blocker below)
**Stage 2 verdict:** DONE_WITH_CONCERNS

### What worked

1. **Config set created** at `infra/local/configs/sepolia/` — all four TOML files, Sepolia-specific addresses and chain-id.
2. **docker-compose.sepolia.yml** parses and boots cleanly. All 6 services came up (migrations exited 0, others running).
3. **Real Sepolia blocks processed** — autopilot tracked blocks 10781020+ at ~12s cadence.
4. **Driver connected** to Sepolia via `testnet-uniswap-v2` preset, found 1 UniswapV2 AMM (WETH/COW pool on TestnetUniswapV2Router02 `0x86dcd3293C53Cf8EFd7303B57beb2a3F671dDE98`).
5. **Valid quote returned** — WETH → COW, 0.0005 WETH → ~0.0279 COW.
6. **Order accepted** (HTTP 201) — EIP-712 signature correctly computed using Sepolia domain separator `0xdaee378bd0eb30ddf479272accf91761e697bc00e067a268f95f1d2732ed230b`.
7. **Baseline solver finds routes** every auction cycle — liquidity sourced, solution encoded, calldata constructed.
8. **Autopilot → driver → baseline solver pipeline** fully functional end-to-end.

### Blocker: Solver not registered in GPv2AllowListAuthentication

The driver-submitter EOA `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` is **not registered** as an authorised solver in Sepolia's `GPv2AllowListAuthentication` contract (`0x2c4c28DDBdAc9C5E7055b4C863b72eA0149D8aFE`).

Every auction cycle the driver:
1. Receives the auction from autopilot ✅
2. Fetches UniswapV2 liquidity (1 AMM found) ✅
3. Baseline solver computes a solution with correct prices ✅
4. Encodes settlement calldata ✅
5. Simulates `GPv2Settlement.settle(...)` with `from=0x00f98b...` → **reverts** because `authenticator.isSolver(0x00f98b...) == false`
6. Discards solution; autopilot logs `SolverDenyListed` ❌

The `GPv2AllowListAuthentication` owner is `0x6Fb5916c0f57f88004d5b5EB25f6f4D77353a1eD` and manager is `0xA03be496e67Ec29bC62F01a428683D7F9c204930` (a 14-signer Gnosis Safe). We do not control either. Stage 1 worked because the anvil fork let us patch the allowlist manager bytecode with `anvil_setCode 0x600160005260206000F3` (always-return-true stub). That trick is unavailable on real Sepolia.

**Resolution path (Phase 2):** Register `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` as a solver via the CoW Protocol team, or deploy our own GPv2 settlement stack with a custom authenticator that we control, or use an Alchemy/Tenderly fork of Sepolia that supports `hardhat_setCode`.

### Sepolia config files created

- `infra/local/configs/sepolia/baseline.toml` — chain-id 11155111, WETH + COW base tokens
- `infra/local/configs/sepolia/driver.toml` — testnet-uniswap-v2 preset, zero-fee, driver-submitter EOA
- `infra/local/configs/sepolia/orderbook.toml` — Sepolia RPC hardcoded (no env var substitution for node-url)
- `infra/local/configs/sepolia/autopilot.toml` — Sepolia RPC, ethflow at `0x0b7795E18767259CC253a2dF471db34c72B49516`, driver-submitter as solver address
- `infra/local/docker-compose.sepolia.yml` — 6 services, no chain container, `SEPOLIA_RPC_URL` from `.env`

## Phase 1 verdict: PARTIAL PASS

- **Stage 1** (forked Gnosis): full end-to-end settlement ✅ PASS
- **Stage 2** (real Sepolia): production-shape stack boots, orders accepted, solver finds routes — blocked at settlement submission by solver registration requirement ⚠️ DONE_WITH_CONCERNS

## Strategic finding: solver allowlist gates self-hosted settlement

CoW Protocol's [`GPv2AllowListAuthentication`](https://docs.cow.fi/cow-protocol/reference/contracts/core) is a permissioned allowlist — only solvers approved by CoW DAO governance can call `GPv2Settlement.settle()` on any of CoW's deployments. Approval is a multi-week governance process: forum proposal → code review → DAO vote → bonded capital. There is no technical bypass; deploying our own settlement is Level 3 in the brief and requires either deploying CoW's audited bytecode unchanged on a chain CoW has not deployed to, or paying for a separate audit.

This invalidates the original spec's assumption that we could ship a self-hosted backend on CoW's chains in Phase 1. The architecture is sound; the deployment is governance-gated.

## Strategic pivot (locked 2026-05-03)

Two-track approach:

1. **Short-term (Phases 1.5 → 2.5): partner-fee injection on CoW's existing chains.** Greg's frontend uses the cowswap fork's existing partner-fee plumbing to route a fixed bps to our recipient address. Orders flow through CoW's official orderbook and settle on CoW's contracts. We earn the partner-fee revenue line described in [CoW Protocol's partner-fee documentation](https://docs.cow.fi/governance/fees/partner-fee). No solver allowlist needed because we are not submitting settlements ourselves. Covers all 10 chains in the [supported networks list](https://docs.cow.fi/cow-protocol/reference/contracts/core) (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Linea, Plasma, Ink, Gnosis).

2. **Mid-term (Phase 3): chain-native fork-deploy on MegaETH.** Deploy [`GPv2Settlement`](https://github.com/cowprotocol/contracts) and [`GPv2VaultRelayer`](https://github.com/cowprotocol/contracts) bytecode unchanged on [MegaETH](https://www.megaeth.com/) (chain ID 4326, mainnet live since Feb 9, 2026), under our own `AllowListAuthentication` deployment. We become the chain-native intent broker on a chain CoW has not deployed to. The vendored `cowprotocol/services` stack we built and validated in Phase 1 (orderbook + autopilot + driver + baseline solver) becomes the production runtime against our own settlement contracts. Apply for [MegaETH ecosystem grants](https://www.megaeth.com/) (foundation reserve = 7.5% of supply) in parallel.

## What's preserved from Phase 1 work

The Rust services stack vendored in this phase is **not discarded** — it is the runtime for Phase 3 on MegaETH. Stage 1's settlement-on-fork validation proves the stack is mechanically correct. The Sepolia config set under `infra/local/configs/sepolia/` is preserved for future re-use if/when CoW DAO ever opens the allowlist. The Gnosis-targeted configs at `infra/local/configs/` and `docker-compose.fork.yml` / `docker-compose.gnosis.yml` will be adapted for MegaETH in Phase 3 (chain-id 4326, MegaETH-native DEX presets).
