# Optimism RPC capacity and recovery

## September 30 maintenance incident: catch-up cannot finish

The September 29 runtime backport (`0dfebe04`, image
`ophis-rpc-autopilot:20260929`) contains a catch-up termination bug. Once an
indexer enters historical mode, it checkpoints at the sampled head minus 128
blocks and always returns `historical event catch-up incomplete`. The next
attempt samples a new head and repeats. Even a stationary head never completes
the final 128 blocks. RPC recovery alone cannot resolve that state.

On September 30, successful essential maintenance stopped at block 157588021
around 13:27 UTC. The alert became pending at 13:37:23 and fired at 13:52:23.
At 14:14 UTC the settlement and onchain-order database cursors were advancing
at 157589325, while refunds remained at 157588021. Essential-maintenance errors
prevent optional refund indexing and settlement attribution from running.
Advancing individual cursors therefore do not establish recovery.

Provider pressure was real: official OP returned HTTP 429 and Nodies hit its
local shared budget while ZAN remained unavailable. Autopilot header demand
rose from about 2.6 requests/second before the stall to about 10 requests/second
during the repeated catch-up. These are client requests, not billed credits.
All seven settlement balance probes passed at 14:14:55; that did not clear the
indexing failure. This incident is separate from the Pons token-list 503.

The correction yields when more than 5,000 historical blocks remain. It then
advances ordinary catch-up in hash-verified checkpoints of at most 16 blocks,
requiring the sampled head before reporting success. The no-reorg path accepts head drift
after partial progress instead of replaying history. Historical checkpoints need
one header; the 64-block event overlap remains. Four-request concurrency,
contiguous-prefix handling, ten-second error cooldown, and fail-closed RPC
consensus remain. The regression follows a persisted empty-range restart through
historical checkpoints and requires completion despite a moving head, with at
most 17 headers per normal tail attempt. A changed anchor still uses the full
reorg-detection window.

The coordinator also waits for all maintenance peers before returning an error.
Previously, a checkpoint yield cancelled the other indexer's in-flight work,
wasting RPC requests and leaving the cursors increasingly out of step. Essential
maintenance still requires every task to succeed; the same completion rule
applies to optional tasks. A regression makes one task fail immediately and
requires its yielding peer to finish before the error is returned.

The first correction at 14:25:28 UTC still fetched the whole 128-header tail on
retries and did not recover under throttling. Bounded tail checkpoints followed
at 14:38:12; the coordinator correction was deployed at **14:49:21 UTC**. Only
autopilot was recreated. A build-cache mismatch between the two checkouts was
resolved by refreshing workspace source timestamps and locking the target cache
across tests and the release build. That verified artifact was deployed at
**14:56:19 UTC**: `ophis-rpc-autopilot:20260930-maintenance-verified`,
ID `sha256:c4acf758a49f958d5a45c92de3049779883eea874f54ad09f7f9faacb618f9d2`.
Runtime source commits: `e29a44c7` and `9c6b3453`.

The live and checked-in autopilot poll interval was restored to **2 seconds at
15:00:54 UTC**. Matching OP block cadence enables the existing parent-hash fast
path. Four-second polling batches multiple blocks and forces extra numbered
header reads; it does not remove the required per-block log reads. The request
budget, voters and protected-read rules remain unchanged.

### Verified recovery

From **15:01:37 to 15:07:39 UTC**, 13 samples showed essential-maintenance lag
between zero and three blocks, with all three persisted cursors advancing near
head. The final refund, onchain-order and settlement cursors all reached
**157591041**, matching the public auction block. No OP alerts were active at
the final check. All seven settlement balance probes passed at 15:03:02 UTC.

The final five-minute window had zero consensus failures and zero rate-limit
rejections from official OP or Nodies. Autopilot header demand was about
**0.61 requests/second**, down from roughly 2.5 during four-second polling and
9–17 during the initial full-tail retries. Provider execution-error counters
were about 0.0037/second on each usable voter; ZAN chain-ID probes still hit its
exhausted allowance. The maintenance incident recovered, while reduced voter
redundancy remains. Detailed local evidence is in
`/private/tmp/ophis-op-maintenance-verified-{deployment,validation}-20260930.json`
and `/private/tmp/ophis-op-maintenance-verified-observation-20260930.jsonl`.

### Recovery procedure

The runtime release suite passed 15 tests (five network tests ignored); the PR
version passed 17 (five ignored). The targeted runtime coordinator regression
also passed on both checkouts after rebuilding workspace crates. The original
completion regression failed before the correction; its extension covers
bounded progress with head drift.

1. Verify the candidate image `ophis-rpc-autopilot:20260930-maintenance-verified` exists
   locally and its event-indexing tests passed. Runtime source is in
   `/Users/scep/ophis-op-rpc-runtime`; the corresponding PR source is in
   `/Users/scep/ophis-op-rpc-optimize`. The build recipe and logs are in
   `/private/tmp/ophis-op-maintenance-verified-20260930.Dockerfile` and
   `/private/tmp/ophis-op-maintenance-verified-20260930.log` and
   `/private/tmp/ophis-op-maintenance-mainline-verified-20260930.log`.
2. Set `[current-block] poll-interval = "2s"` in `configs/autopilot.toml` and
   deploy only autopilot from the actual live Compose directory, retaining its
   remaining environment and configuration. Load the same Keychain entries as
   `compose-up.sh`; full Compose interpolation requires the refunder key even
   though the command below does not recreate refunder. Run without shell
   tracing and do not print either secret. Do not rebuild that older checkout:

   ```sh
   cd /Users/scep/greg-wt/op-deploy-0730/infra/optimism-mainnet
   export OPHIS_INTER_SERVICE_AUTH_TOKEN="$(security find-generic-password -a "$USER" -s ophis-inter-service-auth-token -w)"
   export OPHIS_REFUNDER_PK="$(security find-generic-password -s ophis-refunder-pk -w)"
   OP_AUTOPILOT_IMAGE=ophis-rpc-autopilot:20260930-maintenance-verified \
     docker compose config --quiet
   OP_AUTOPILOT_IMAGE=ophis-rpc-autopilot:20260930-maintenance-verified \
     docker compose up -d --no-deps --no-build --pull never autopilot
   ```

   If only the bind-mounted TOML changed and the image is already selected,
   `docker compose restart autopilot` is needed to load the new poll interval.

3. Require essential maintenance to resume and remain near head for a complete
   five-minute observation window. Check all three persisted cursors, including
   refunds, and require the public auction block to advance:

   ```sh
   curl -fsSG http://127.0.0.1:9091/api/v1/query \
     --data-urlencode 'query=gp_v2_autopilot_last_block_number-gp_v2_autopilot_autopilot_maintenance_last_updated_block'
   docker exec optimism-mainnet-db-1 psql -U ophis -d ophis \
     -c 'SELECT * FROM last_indexed_blocks ORDER BY 1'
   curl -fsS https://optimism-mainnet.ophis.fi/api/v1/auction
   ```

4. Check the alert cleared in Prometheus, measure low-participant errors and
   provider throttling over the same window, and run the existing buffer probe
   without publishing monitoring data:

   ```sh
   curl -fsS http://127.0.0.1:9091/api/v1/alerts
   curl -fsSG http://127.0.0.1:9091/api/v1/query \
     --data-urlencode 'query=sum by(error)(rate(erpc_consensus_errors_total{network="evm:10"}[5m]))'
   curl -fsSG http://127.0.0.1:9091/api/v1/query \
     --data-urlencode 'query=sum by(upstream,error)(rate(erpc_upstream_request_errors_total{network="evm:10"}[5m]))'
   env -u PUSHGATEWAY_URL -u FEE_LIQUIDATOR bash scripts/check-settlement-buffer.sh
   ```

5. Once image identity and configuration are verified, persist the selected
   image in the operator's normal `OP_AUTOPILOT_IMAGE` environment setting so a
   later Compose invocation retains it. The one-command override is not
   persistent. The live `.env` selection was updated and Compose-validated on
   September 30, preserving all other settings and file permissions. Persistence
   establishes deployment; the live checks above establish recovery.

If the candidate introduces a new failure, the same targeted Compose command
with `OP_AUTOPILOT_IMAGE=ophis-rpc-autopilot:20260929` restores the previous
binary. That rollback also restores this known catch-up bug; it is not an
incident resolution. No schema migration, RPC provider change, limiter increase,
driver restart, or manual database-cursor advancement is part of this repair.
The exhausted third voter remains a separate capacity risk after recovery.

## Provider capacity background

Updated 2026-09-29. Configured read voters: official OP (`mainnet.optimism.io`),
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
assume a top-up. On September 29 the operator confirmed ZAN remains exhausted;
it returns HTTP 429 with a package-credit error. Until its allowance returns,
both official OP and Nodies must agree for protected reads to succeed. There is
no spare voter. Successful chain-ID reads do not prove remaining account quota.
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
Header and event catch-up share a maximum of four concurrent RPC requests per
fetch. Historical maintenance checkpoints at most 5,000 blocks per attempt,
retains the 64-block reorg overlap, and avoids fetching moving-tip headers until
the final historical chunk. Tail checkpoints process at most 16 blocks at a time.
It stops consuming RPC pages on the first error and backs off that indexer for
ten seconds. Partial checkpoints return an error, so essential maintenance
cannot publish a current auction from them.
This fixes the refund indexer's repeated historical scan that saturated the two
remaining providers during the September 27–29 incident.

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

The public Nodies endpoint allows at most 50 blocks per log request. The private
endpoint was verified with 500-block requests on September 29. The pinned eRPC
0.2.0 field is `evm.getLogsAutoSplittingRangeThreshold: 500` on that upstream.
This avoids expanding each 500-block indexer page into ten consensus calls. The old
`getLogsMaxBlockRange` name is silently ignored by this version. Native splitting
routes every child request through consensus. The local regression rejects one
voter, accepts two, and checks that a 1,001-block range is split into children no
larger than 500 blocks. Keep the shared 180/minute allowance unchanged.
The live 500-block WETH Deposit filter returned 121 identical logs from official
OP, Nodies and the proxy. An unfiltered 500-block request returned 10,566 logs
from Nodies but exceeded official OP's response limit; the proxy correctly
returned a quorum error. Dense queries still need narrower filters or ranges.

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
ordinary temporary files. Select images with `OP_DRIVER_IMAGE` and
`OP_AUTOPILOT_IMAGE` so previous local images remain available for rollback.
The September 29 autopilot backport is `ophis-rpc-autopilot:20260929`; its prior
image is retained as `ophis-rpc-autopilot:before-20260929`.

Run from the repository root:

```sh
python3 scripts/test-boost-rpc.py
python3 scripts/test-op-erpc-quorum.py
cd apps/backend && cargo test --locked -p event-indexing --lib
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
Check a full post-deployment five-minute window of consensus errors and require
advancing refund, order and settlement cursors near the chain head. A provider
unable to initialize can lack network-specific head metrics; an absent lag alert
does not establish recovery. ZAN's exhaustion remains an open dependency until
it contributes successful votes under normal load.
