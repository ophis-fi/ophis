# Arc local build (5042)

The local lab builds Ophis contracts, configures the backend, and exercises Arc
USDC swaps through direct Uniswap/Synthra/AchSwap V3 solvers, with KyberSwap and LI.FI optional.
The frontend adds an opt-in Arc deployment gate and an inbound Across USDC route from supported source chains.
Production packaging and the operator ceremony: [release/README.md](release/README.md).
The Arc mainnet stack is live; see the release runbook for deployment records.

Run instructions and validation: [local/README.md](local/README.md).
Read-only pool/quote/router verification: [LIQUIDITY.md](LIQUIDITY.md).
Automatic local settlement, unsigned bridge and measured RPC usage: [VALIDATION.md](VALIDATION.md).
No production node, paid plan, API key, or live dRPC traffic is required for tests.
The dRPC gate uses the keyless public endpoint; its reserved CU allowance belongs
in the gitignored `.env` (mode 0600). RPC proxy tests start disposable containers on a network without
internet access; the backend lab uses loopback fixtures. Neither starts the live proxy.

## Routing and budget

- Public quote admission stays paced globally at twelve requests/minute across quote
  and draft routes. Two excess requests may wait up to 10 seconds; further requests
  receive JSON HTTP 429 with `Retry-After: 5`. Every protected read needs one
  non-keyed voter (free providers or dRPC) beside Validation Cloud; that pool carries
  about twelve warm quotes/minute. Trade quotes use five lanes: SushiSwap v3's Arc
  USDC/EURC pools hold dust liquidity, so it bids only in auctions and native prices.
  It is bounded admission, not additional provider capacity or a guarantee against
  upstream outages.
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
- dRPC (`https://arc.drpc.org`): bounded fallback for `eth_call`, `eth_estimateGas`, `eth_getBalance`,
  `eth_getCode`, `eth_getBlockByNumber` headers and `eth_gasPrice`, plus
  `debug_traceTransaction` after settlement.
  Protected reads still require two distinct agreeing providers. dRPC alone
  cannot restore a quorum when all other providers are unavailable.
- Validation Cloud (keyed): extra quote capacity for `eth_call`, `eth_estimateGas`,
  `eth_getBalance`, `eth_getCode`, `eth_getBlockByNumber` headers and `eth_gasPrice`.
  It sorts after the free providers and before dRPC, so it only fills a voter that
  a rate-limited or failing free provider left open. It never counts as two voters
  and receives no logs, relay or traces. The API key stays in its private gate.
- Each unmetered public upstream has a pooled 120 requests/minute limit. dRPC has a
  pooled 5,000 CU/minute and 400,000 CU/day limit. Auto-tuning, hedging
  and upstream retries are disabled. Each protected-read voter can make at most
  three network attempts (six total), so two failed free legs do not hide the
  fourth provider from a surviving voter; other methods have one network attempt.
  Unmetered providers sort before dRPC, so healthy quorums use no dRPC state
  reads. Quota exhaustion fails closed; failed attempts remain charged.
- Fixed-number finalized headers are cached for one hour; successful quorum-verified
  `eth_call` reads at explicit finalized blocks for one minute. Calldata and caller
  remain part of the cache key. Live/pending state and state/block overrides are
  not cached. eRPC also coalesces simultaneous requests.
- Native prices try Uniswap v3 and KyberSwap first, with Archery, Aero, Uniswap
  v4 and SushiSwap v3 as fallback if fewer than two estimates succeed. Auctions
  compete across all six lanes; trade quotes across five (no SushiSwap v3). After five consecutive internal estimator
  failures, the price cache permits another probe after ten seconds (or the
  configured price TTL, if shorter); successful prices retain their normal TTL.
- The pilot denies transaction relay. The release permits signed transaction relay
  through one free official upstream; nonce/state reads still require two voters.
  Full-block tracing, replay, unrestricted debug and client provider overrides are denied.

[dRPC's method costs](https://drpc.org/docs/pricing/compute-units) are 20 CU per
allowed read or transaction trace; the gate conservatively reserves 20 CU even
for the zero-CU chain-ID bootstrap. At the daily ceiling this stack uses at most
**12.4M CU in 31 days**, under **6% of the 210M free allowance**.
The private gate reserves CU in SQLite before each attempt, with a fixed
operator-selected lifetime allowance (maximum 180M, leaving 30M unallocated).
There is no automatic monthly refill: the daily cap bounds monthly use without
depending on the account reset date. The pilot and release share the named
`ophis-arc-drpc-cu` volume, so restarts and switching stacks do not reset usage.
The old `ophis-arc-quicknode-credits` volume is retained and never reused for dRPC.
This ledger cannot account for unrelated dRPC consumers: reserve
only CU actually available, retain the volume, and monitor provider totals.
Do not delete the ledger or run separate ledgers against the same reserved allowance.

Validation Cloud's free team gets 50M CU per UTC month and is disabled when it
runs out (seen on OP in August 2026). Its docs price `eth_call`, `eth_estimateGas`
and `eth_getBlockByNumber` at 40 CU, so its gate charges 40 CU for every allowed
read, before the attempt, failures included: 20,000 CU/minute and
1,500,000 CU/day. Any month therefore stays under **46.5M CU** without tracking
the reset date. Its ledger is the separate `ophis-arc-validationcloud-cu` volume.
The quota counts every endpoint on the account: do not run other consumers on it.

eRPC v0.2.0 treats a zero poll interval as its default, and its internal poller
bypasses method filters. dRPC therefore polls only hourly (two standard
header calls, approximately 960 CU/day, charged to the same budget). Validation
Cloud polls hourly too (approximately 1,920 CU/day instead of ~230k at 30 seconds).
Initial bootstrap also checks the chain ID once (20 CU reserved).
Public providers poll every 30 seconds. Account usage remains the source of truth.

## RPC validation

```sh
python3 infra/arc-mainnet/test_rpc.py
```

These tests do not start the live proxy. The backend lab uses Arc Anvil on
loopback, not the production RPC proxy. This separation
keeps simulation, compilation and regression tests outside the dRPC allowance.
The release tooling prepares unsigned deployments, validates governance and
contract wiring, renders services, and gates frontend/signing activation on real
deployment evidence. Never substitute local fixture addresses for mainnet records.

2026-09-22 capability check: four direct QuickNode calls (estimated 100 credits)
verified chain 5042, code override, native-USDC balance override and nested
`callTracer` output. No dRPC calls, transactions, or live load tests were used.
TypeSafe Jev assisted a one-shot design check using redacted requirements;
runtime routing and accounting remain deterministic, with no TypeSafe dependency.
