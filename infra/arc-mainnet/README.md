# Arc local build (5042)

The local lab builds Ophis contracts, configures the backend, and exercises Arc
USDC swaps through direct Uniswap/Synthra/AchSwap V3 solvers, with KyberSwap and LI.FI optional.
The frontend adds an opt-in Arc deployment gate and an inbound Across USDC route from supported source chains.
Production packaging and the operator ceremony: [release/README.md](release/README.md).
**Nothing here has been deployed to a public chain or merged.**

Run instructions and validation: [local/README.md](local/README.md).
Read-only pool/quote/router verification: [LIQUIDITY.md](LIQUIDITY.md).
Automatic local settlement, unsigned bridge and measured RPC usage: [VALIDATION.md](VALIDATION.md).
No production node, paid plan, or dRPC traffic is required. The private
QuickNode URL belongs only in the gitignored `.env` (mode 0600), never frontend
chain configuration. RPC proxy tests start disposable containers on a network without
internet access; the backend lab uses loopback fixtures. Neither starts the live proxy.

## Routing and budget

- Official Arc + Blockdaemon public RPC: two agreeing responses for protected
  state, simulations, headers, logs and receipts; disagreement or missing quorum
  returns an error. This is a managed-provider trust model, not local validation.
- QuickNode: only `debug_traceTransaction`, needed by autopilot after settlement.
  Its successful capability check means dRPC can remain entirely unused by Arc.
- Each public upstream has a pooled 120 requests/minute limit. QuickNode has a
  pooled 1,000 credits/minute and 40,000 credits/day limit. Auto-tuning, hedging,
  network retries and upstream retries are disabled. Quota exhaustion fails closed.
- Fixed-number finalized headers are cached for one hour. Live state, pending
  data and simulations are not cached. eRPC also coalesces simultaneous requests.
- The pilot denies transaction relay. The release permits signed transaction relay
  through one free official upstream; nonce/state reads still require two voters.
  Full-block tracing, replay, unrestricted debug and client provider overrides are denied.

[QuickNode's Arc pricing](https://www.quicknode.com/api-credits/arc) is 20 credits
per standard method, 40 per transaction trace. 10M credits is **not** 10M requests.
At the daily ceiling this pilot uses about **1.24M credits in 31 days**, leaving
most of the allowance reserved. No renewal of the supplied 10M is assumed.
The private credit gate also reserves credits in SQLite before each attempt, with
a fixed operator-selected remaining allowance (maximum 10M). The pilot and release
share the same named volume, so restarts and switching stacks do not reset it.
This ledger cannot account for unrelated consumers of the provider key: reserve
only the credits actually available, retain the volume, and monitor provider totals.
Do not delete the ledger or run separate ledgers against the same reserved allowance.

eRPC v0.2.0 treats a zero poll interval as its default, and its internal poller
bypasses method filters. QuickNode therefore polls only hourly (two standard
header calls, approximately 960 credits/day, charged to the same budget).
Initial bootstrap also checks the chain ID once (20 credits).
Public providers poll every 30 seconds. Account usage remains the source of truth.

## RPC validation

```sh
python3 infra/arc-mainnet/test_rpc.py
```

The proxy compose file is prepared but was not started against live providers.
The backend lab uses Arc Anvil on loopback, not this RPC proxy. This separation
keeps simulation, compilation and regression tests outside the 10M allowance.
The release tooling prepares unsigned deployments, validates governance and
contract wiring, renders services, and gates frontend/signing activation on real
deployment evidence. Never substitute local fixture addresses for mainnet records.

2026-09-22 capability check: four direct QuickNode calls (estimated 100 credits)
verified chain 5042, code override, native-USDC balance override and nested
`callTracer` output. No dRPC calls, transactions, or live load tests were used.
TypeSafe Jev assisted a one-shot design check using redacted requirements;
runtime routing and accounting remain deterministic, with no TypeSafe dependency.
