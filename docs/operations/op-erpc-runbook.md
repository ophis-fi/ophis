# Optimism RPC capacity and recovery

Updated 2026-09-21. Current read voters: official OP (`mainnet.optimism.io`),
keyed ZAN (`api.zan.top`), and public Nodies (`op-pokt.nodies.app`).
Validation Cloud returned HTTP 401 `api client is disabled`; the operator
confirmed exhausted quota. Public dRPC passed bounded comparisons but then
rate-limited under live traffic and was rejected as the replacement.

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
An RPC failure omits the token; it never reuses a cached balance or invents zero.
The regression covers idle block updates, fresh reads, failed reads and real zero.

Driver and orderbook block polling use two seconds instead of 500 milliseconds.
The driver setting is `BLOCK_STREAM_POLL_INTERVAL`; the orderbook setting is
`[shared.current-block] poll-interval`. Application startup validates the latter;
a syntactically valid TOML file with `[current-block]` at the root is rejected.

The existing bounded numbered-header cache and indexer concurrency limits remain.
Protected balances, receipts, transactions and logs are not cached. Slowing the
autopilot loop does not remove required per-block log indexing and is not a fix
for monthly log consumption. Do not reduce the hourly monitor to hide this issue.

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

Nodies allows at most 50 blocks per log request. The pinned eRPC 0.2.0 field is
`evm.getLogsAutoSplittingRangeThreshold: 50` on that upstream. The old
`getLogsMaxBlockRange` name is silently ignored by this version. Native splitting
routes every child request through consensus. The local regression rejects one
voter, accepts two, and enforces the provider's 50-block ceiling.

Allow at least 20 seconds after proxy startup before testing provider outages.
The routing policy refreshes every 15 seconds; a provider that registers after
the initial snapshot can otherwise be absent from early requests even though it
answers direct calls. `/healthcheck` alone does not establish a working quorum.

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
