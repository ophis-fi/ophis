# Phase 0 — Validation Log

> **Goal:** Confirm a real swap completes on Gnosis Chiado testnet via the Greg-branded frontend hitting CoW's official APIs. This is the Phase 0 gate.

**Date:** _(fill in when executing)_
**Operator:** Clement

---

## Setup

- **Repo:** `san-npm/greg`
- **Repo HEAD at validation:** `<git rev-parse HEAD>` _(fill in)_
- **Vercel preview URL:** https://greg-29v5viw8p-clementfrmds-projects.vercel.app
- **Backend stack:** CoW Protocol's official APIs (Gnosis/Chiado). No self-hosted Greg backend in Phase 0.

## Test wallet

- **Address:** `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB`
- **Private key:** stored in macOS Keychain under entry `greg-chiado-test` (account + service both `greg-chiado-test`). Retrieve with: `security find-generic-password -a greg-chiado-test -s greg-chiado-test -w`.
- **Funded via:** _(faucet URL — recommended: https://gnosisfaucet.com → select Chiado)_

## Swap

- **Network:** _(Chiado testnet | Gnosis mainnet — note reason if not Chiado)_
- **Pair:** _(e.g., `xDAI → USDC.testnet` — fill in actual pair after the trade)_
- **Amount in:** _(e.g., 0.001 xDAI)_
- **Order UID (from CowSwap UI after signing):** _(0x...)_
- **Settlement tx hash:** _(0x...)_
- **Block explorer link:** _(https://gnosis-chiado.blockscout.com/tx/0x... or current Chiado explorer)_
- **Time-to-settle (signed → on-chain):** _(seconds)_

## Branding sanity

- [ ] Window title / browser tab shows `Greg`
- [ ] Manifest name (Add to Home Screen) shows `Greg`
- [ ] No accidental references to `cowswap.fi` in user-visible UI
- [ ] No "CoW Swap" in the page header

## Build & deploy provenance

- **Frontend build pipeline:** Vercel project `greg`, build script `scripts/vercel-build.sh`, output `apps/frontend/build/cowswap/` (53MB).
- **Cowswap upstream pinned at:** `0174f35e737df0a3129c140b386dca56bb4f3f00` (see `apps/frontend/.greg-upstream`).
- **Services upstream pinned at:** `0720b9bc15138ecc362078f505d0e3ba1c7b9883` (see `apps/backend/.greg-upstream`) — **not deployed in Phase 0**, only built locally.

## Issues encountered during the swap

_(bulleted list, or "none")_

## Phase-0 gate verdict

_(PASS | FAIL)_ — _(one-line summary; if FAIL, what blocks)_
