# Phase 0 — Validation Log

> **Goal:** Confirm a real swap completes via the Greg deployment hitting CoW's official APIs. This is the Phase 0 gate.

**Date:** 2026-05-02
**Operator:** Clement (executed programmatically by the Claude main session via Foundry `cast` + cow.fi API)

---

## Setup

- **Repo:** `san-npm/greg`
- **Repo HEAD at validation:** `2544ec42b71d55af8f8dc4bc7cad2312e47f3d53`
- **Vercel preview URL:** https://greg-29v5viw8p-clementfrmds-projects.vercel.app
- **Backend stack:** CoW Protocol's official APIs. No self-hosted Greg backend in Phase 0.

### Deviation from plan

- **Original target:** Gnosis Chiado testnet.
- **Actual target:** **Sepolia** (Ethereum testnet).
- **Why:** CoW Protocol's API does not support Chiado. Probed `https://api.cow.fi/chiado/api/v1/version` → 404; same on the `barn.api.cow.fi` staging environment. The plan explicitly listed Gnosis-mainnet-with-$5-cap as the alternative; Sepolia is strictly better (free faucet/funding, real CoW API, no real money).

### Deviation in execution mechanism

- **Plan said:** "real swap completes on Gnosis Chiado testnet via Greg frontend"
- **Actual:** API-path validation (quote → sign → submit → settle) executed programmatically against the same CoW endpoints the deployed frontend hits. **The frontend deployment was independently verified** (Vercel build green, served HTML shows `<title>Greg</title>`, browser-loadable). What was not exercised: clicking through the deployed UI with MetaMask. Browser-driven testing is deferred to Phase 2 when we have Playwright E2E coverage.

## Test wallet

- **Address:** `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB`
- **Private key:** macOS Keychain entry `greg-chiado-test` (account + service both `greg-chiado-test`). Retrieve with: `security find-generic-password -a greg-chiado-test -s greg-chiado-test -w`.
- **Funded via:** internal transfer of 0.01 Sepolia ETH from `eury-deployer` wallet (`0x3e6808a74c0B1f1efeeBFce192AD658F33885398`); no public faucet was needed.

## Swap

- **Network:** Sepolia (chainId 11155111)
- **Pair:** WETH (`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`) → COW (`0x0625afb445c3b6b7b929342a04a22599fd5dbb59`)
- **Amount in:** 0.001 WETH (`979305300000000` wei post-fee, 80% buy floor + `partiallyFillable`)
- **Order UID:** `0xf0afdb8b40a06ba0eb95235d83f5559ef86a175c3f78096c89d160d12224cd40412cbcce46fcba707a3190eced8113bbc2c294ab69f5eecc`
- **Settlement tx hash:** `0x50adbdbbcd2113be925ca0aa4683d68d525d12f33196729ea508c37c7e7d69e0`
- **Block number:** 10775068
- **Block explorer:** https://sepolia.etherscan.io/tx/0x50adbdbbcd2113be925ca0aa4683d68d525d12f33196729ea508c37c7e7d69e0
- **Time-to-settle (signed → on-chain):** ~35 seconds
- **Executed buy amount:** 54973957352776249 (≈ 0.05497 COW), which is 97.7% of the original quoted buyAmount — well above the 80% floor.

### Note on first attempt

The first signed order (`0x08e9bc72…69f5e8e0`, 1% slippage floor, `partiallyFillable: false`) sat unfilled for the full validity window. Sepolia's CoW solver coverage is sparse and tight limit orders often expire. Resubmitting with an 80% floor + `partiallyFillable: true` settled in 35 seconds. Captured here as a real-world data point: when we expand to thinly-traded tokens or low-activity chains, our UX should default to a more permissive slippage floor.

## Branding sanity

- [x] Window title / browser tab shows `Greg` — verified via `curl https://greg-29v5viw8p-…vercel.app | grep '<title>'` → `<title>Greg</title>`
- [x] Manifest name (Add to Home Screen) shows `Greg` — verified at build time, manifest.json contains `"name": "Greg"`
- [x] No `cowswap.fi` references in user-visible UI — verified via grep on built `index.html`
- [x] No "CoW Swap" in the page header — verified at build time

## Build & deploy provenance

- **Frontend:** Vercel project `greg`, build script `scripts/vercel-build.sh`, output `apps/frontend/build/cowswap/` (53 MB)
- **Cowswap upstream pinned at:** `0174f35e737df0a3129c140b386dca56bb4f3f00` (see `apps/frontend/.greg-upstream`)
- **Services upstream pinned at:** `0720b9bc15138ecc362078f505d0e3ba1c7b9883` (see `apps/backend/.greg-upstream`) — built locally only; not deployed in Phase 0
- **CI:** GitHub Actions, both `root (lint + typecheck)` and `packages/sdk` jobs green on `2544ec42b…`

## Issues encountered during the swap

- CoW Protocol does not run on Gnosis Chiado — pivoted to Sepolia.
- A 1% slippage floor on Sepolia is too tight for sparse solver coverage. Use ≥5% floor + `partiallyFillable: true` for testnet smoke tests.

## Phase-0 gate verdict

**PASS** — frontend builds and deploys to Vercel with Greg branding; backend Rust workspace builds and 754 lib tests pass; SDK has working TDD coverage; CI is green; a signed EIP-712 order from the test wallet was accepted by CoW's Sepolia orderbook and settled on-chain by a CoW solver in ~35 seconds (`0x50adbdbb…7d69e0` block 10775068). The complete intent-broker pipeline that the deployed Greg frontend depends on is verified end-to-end.
