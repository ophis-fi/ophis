# Arc local build (5042)

The local lab builds Ophis contracts, configures the backend, and exercises Arc
USDC swaps through direct Uniswap/Synthra/AchSwap V3 solvers, with KyberSwap and LI.FI optional.
The frontend adds an opt-in Arc deployment gate and an inbound Across USDC route from supported source chains.
Production packaging and the operator ceremony: [release/README.md](release/README.md).
The Arc mainnet stack is live; see the release runbook for deployment records.

Run instructions and validation: [local/README.md](local/README.md).
Read-only pool/quote/router verification: [LIQUIDITY.md](LIQUIDITY.md).
Automatic local settlement, unsigned bridge and measured RPC usage: [VALIDATION.md](VALIDATION.md).
No production node, paid plan, or dRPC traffic is required. The private
QuickNode URL belongs only in the gitignored `.env` (mode 0600), never frontend
chain configuration. RPC proxy tests start disposable containers on a network without
internet access; the backend lab uses loopback fixtures. Neither starts the live proxy.

## Routing and budget

- Public quote admission is paced globally at six requests/minute across quote
  and draft routes. Two excess requests may wait up to 20 seconds; further requests
  receive JSON HTTP 429 with `Retry-After: 10`. This leaves RPC headroom instead of
  sending six quotes into all five lanes at once. It is bounded admission, not
  additional provider capacity or a guarantee against upstream outages.
- Official Arc + Blockdaemon + PublicNode public RPC first: two agreeing responses for protected
  state, simulations, headers, logs and receipts; disagreement or missing quorum
  returns an error. This is a managed-provider trust model, not local validation.
- PublicNode (Allnodes) is keyless and independently operated. It serves recent
  quote/balance reads with its own 120 requests/minute cap; it does not receive
  indexing logs, transaction relay or traces. Archive access is not assumed:
  rejected historical reads can fall back to the existing providers.
  [Allnodes lists free Arc RPC access](https://www.allnodes.com/).
  September 28 probes matched Blockdaemon's block hash, USDC balance and EIP-1898
  code-override simulation. This is not an uptime or unlimited-capacity guarantee.
- QuickNode: bounded fallback for `eth_call`, `eth_estimateGas`, `eth_getBalance`,
  `eth_getCode`, `eth_getBlockByNumber` headers and `eth_gasPrice`, plus
  `debug_traceTransaction` after settlement.
  Protected reads still require two distinct agreeing providers. Paid reads alone
  cannot restore a quorum when all free providers are unavailable. No dRPC calls.
- Each public upstream has a pooled 120 requests/minute limit. QuickNode has a
  pooled 1,000 credits/minute and 40,000 credits/day limit. Auto-tuning, hedging
  and upstream retries are disabled. Each protected-read voter can make at most
  three network attempts (six total), so two failed free legs do not hide the
  fourth provider from a surviving voter; other methods have one network attempt.
  Free providers sort before QuickNode, so healthy free quorums use no paid state
  reads. Quota exhaustion fails closed; failed attempts remain charged.
- Fixed-number finalized headers are cached for one hour; successful quorum-verified
  `eth_call` reads at explicit finalized blocks for one minute. Calldata and caller
  remain part of the cache key. Live/pending state and state/block overrides are
  not cached. eRPC also coalesces simultaneous requests.
- Native prices try Uniswap v3 and KyberSwap first, with Archery, Aero and Uniswap
  v4 as fallback if fewer than two estimates succeed. Trade quotes and auctions
  still compete across all five lanes. After five consecutive internal estimator
  failures, the price cache permits another probe after ten seconds (or the
  configured price TTL, if shorter); successful prices retain their normal TTL.
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

These tests do not start the live proxy. The backend lab uses Arc Anvil on
loopback, not the production RPC proxy. This separation
keeps simulation, compilation and regression tests outside the 10M allowance.
The release tooling prepares unsigned deployments, validates governance and
contract wiring, renders services, and gates frontend/signing activation on real
deployment evidence. Never substitute local fixture addresses for mainnet records.

2026-09-22 capability check: four direct QuickNode calls (estimated 100 credits)
verified chain 5042, code override, native-USDC balance override and nested
`callTracer` output. No dRPC calls, transactions, or live load tests were used.
TypeSafe Jev assisted a one-shot design check using redacted requirements;
runtime routing and accounting remain deterministic, with no TypeSafe dependency.
