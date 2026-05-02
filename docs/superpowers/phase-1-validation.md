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
