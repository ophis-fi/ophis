# Optimism RPC capacity and recovery

Updated 2026-09-21. Active read voters: official OP (`mainnet.optimism.io`),
keyed ZAN (`api.zan.top`), and private Nodies (`lb.nodies.app/v2/optimism`).
The operator supplied an existing free-account endpoint. Its key stays in
`NODIES_OP_KEY`, outside Git, and credential-bearing renders remain on RAM disk.
The operator confirmed **4M requests remaining through September 30** on
September 21. Private Nodies was activated at 19:53 UTC with the bounded budget
below. The RPC does not expose account limits; the dashboard remains the source
of truth. Paid overage settings were not confirmed or changed.
Validation Cloud returned HTTP 401 `api client is disabled`; the operator
confirmed exhausted quota. Public dRPC passed bounded comparisons but then
rate-limited under live traffic and was rejected as the replacement.
Public Nodies also rate-limited after the initial healthy window and was replaced
by the private account. Verify that the private voter contributes under real
traffic; a healthy buffer probe alone can hide a broken third provider.

The operator has no budget for paid capacity. Do not activate a paid tier or
assume a top-up. ZAN still answers but the operator previously reported its
credits exhausted; successful reads do not prove remaining account quota.
Public endpoints have rate limits. This recovery is not an unlimited-capacity
guarantee. The retired OP node is unreachable; the reachable Ophis servers run
Unichain. An owned OP node remains the durable way to remove one dependency on
external provider capacity.

## Reduced demand

The driver previously refreshed settlement balances for **every token it had
encountered, on every block, indefinitely**. It now caches symbol/decimals only,
fetches balances for requested tokens, and shares overlapping in-flight reads.
Balance-read failures propagate through quotes and auction preprocessing as
HTTP 503 `BalanceUnavailable`; they never become missing entries that callers
could interpret as zero. Cached metadata survives balance failures. Missing
optional metadata still triggers a fresh balance read. The regressions cover
idle block updates, fresh reads, both error mappings, missing metadata and real zero.

Driver and orderbook block polling use two seconds instead of 500 milliseconds.
The driver setting is `BLOCK_STREAM_POLL_INTERVAL`; the orderbook setting is
`[shared.current-block] poll-interval`. Application startup validates the latter;
a syntactically valid TOML file with `[current-block]` at the root is rejected.

The existing bounded numbered-header cache and indexer concurrency limits remain.
Protected balances, receipts, transactions and logs are not cached. Slowing the
autopilot loop does not remove required per-block log indexing and is not a fix
for monthly log consumption. Do not reduce the hourly monitor to hide this issue.

## Nodies allowance

The native eRPC limiter admits at most **180 requests/minute** across all methods,
including its state poller. `rateLimitCountMode: credit` with `creditUnits: {"*": 1}`
creates one shared request pool; the default request mode would create separate
method counters. Autotuning is explicitly disabled. Nodies has one upstream
attempt because eRPC charges before upstream retries; network retries acquire
another permit. A local regression exhausts the pool across two different methods.

At the ceiling, proxy traffic through the end of September 30 is below **2.4M**,
leaving more than **1.6M** of the confirmed allowance for submission, startup,
other clients and reserve. Driver submission goes directly to providers and is
outside this cap. Memory counters reset on proxy restart; this is a consumption
rate limit, not an account-wide monthly billing lock. Check dashboard totals if
other applications share the key or the proxy is repeatedly restarted. No paid
plan, top-up or overage setting was enabled. Reassess against the dashboard's
actual renewed allowance after September 30; 4M remaining is not a claim about
the account's full-month allocation.

## Quorum and provider checks

All protected methods require two matching votes from exactly three eligible
providers. Disputes and low participation return errors. The maximum waits remain
12 seconds. Do not lower the threshold, add an unrestricted fourth voter, or
bypass the proxy with `OP_RPC_INTERNAL`.

Failure domains: official OP is Google-fronted, ZAN Alibaba, and Nodies Cloudflare.
Nodies was checked against independent responses for current balances, contract
code/storage, gas estimation, fee history, transaction lookup, populated receipts
and populated logs. A canary with the official voter deliberately unavailable
passed balance/receipt checks and a 101-block historical log request.

The public Nodies endpoint allows at most 50 blocks per log request; keep the
conservative 50-block split for the private endpoint until a larger range is verified. The pinned eRPC 0.2.0 field is
`evm.getLogsAutoSplittingRangeThreshold: 50` on that upstream. The old
`getLogsMaxBlockRange` name is silently ignored by this version. Native splitting
routes every child request through consensus. The local regression rejects one
voter, accepts two, and enforces the provider's 50-block ceiling.

Allow at least 20 seconds after proxy startup before testing provider outages.
The routing policy refreshes every 15 seconds; a provider that registers after
the initial snapshot can otherwise be absent from early requests even though it
answers direct calls. `/healthcheck` alone does not establish a working quorum.

The private endpoint passed current balance, receipt, populated-log, 101-block
split-log and recent-fee-history canary requests while the official voter was
unavailable. Nine protected historical responses matched the independent
baseline. One older fee-history response differed in `blobGasUsedRatio`; recent
fee history agreed across all three providers. Do not add ignored fields to
force agreement; retain the existing fail-closed policy on disagreements.

## Submission

Submission relays are PublicNode, official OP and Nodies. Official OP and Nodies
must remain in both reads and submission to preserve pending-nonce overlap.
Overlap mitigates propagation lag; it is not a guarantee. An invalid empty raw
transaction returned the expected validation error during endpoint testing; no
signed transaction or fund movement was used to test this change.

## Verification and rollback

Live checkout: `/Users/scep/greg-wt/op-deploy-0730/infra/optimism-mainnet`.
Confirm actual bind mounts with Docker inspect. Keep credential-bearing renders
and backups on the existing RAM disk. Do not copy rendered driver secrets into
ordinary temporary files. The driver image can be selected with `OP_DRIVER_IMAGE`
so the previous local image remains available for rollback.

Run from the repository root:

```sh
python3 scripts/test-boost-rpc.py
python3 scripts/test-op-erpc-quorum.py
```

Run the settlement buffer script with `PUSHGATEWAY_URL` unset for a read-only
check. Every one of its seven rows must have status `ok`; any failure means
UNKNOWN. Confirm advancing autopilot maintenance blocks, healthy driver and
orderbook, and actual upstream errors, not just successful chain-ID probes.

Prometheus is on loopback port 9091. Compare per-upstream/category rates from
`erpc_upstream_request_total`, upstream errors, and client method rates from
`alloy_rpc_requests_complete`. Client poll reductions and total provider request
reductions are different measurements. Request counts are not billing credits;
providers price methods differently.

Recreate only affected services after validating candidate config. Keep previous
rendered files and the prior image tag for rollback. A provider that passes a
small diagnostic probe can still fail under the live workload; check both.
