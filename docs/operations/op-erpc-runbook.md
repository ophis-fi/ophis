# Optimism RPC capacity and recovery

## November 1, 2026: reduce Alchemy CU consumption

Operator constraint remains **no spending**. The supplied key matches the
installed Alchemy credential; no new account, plan, recharge or overage was
enabled. Keys remain in the existing environment and RAM-backed render, outside
Git and incident evidence.

Three OP indexers previously requested logs separately for every block, even
when none of their contracts emitted an event. These reads contributed 1.5
Alchemy requests/s and 90 estimated CU/s. The total baseline was approximately
124 CU/s using Alchemy's published per-method prices. Local `creditUnits: 1`
is a request limiter override and does not change those prices. Transport
batching also bills each individual method.

OP's settlement, onchain-order and EthFlow-refund retrievers now first request
the block by its explicit hash. eRPC requires two agreeing providers, then
caches only nonempty, explicit-hash headers for one hour in the existing
bounded header cache. The backend recomputes the canonical header hash before
using its `logsBloom`. Only a proven address/topic absence returns no events.
Missing, failed, inconsistent or possibly matching headers fall through to the
existing consensus log read; the optional precheck has a two-second deadline.
Historical range queries, indexing frequency and other chains retain their
existing behavior. Logs, receipts and mutable state remain uncached.

`eth_getBlockByHash` is now a protected Block A method. Tagged and numbered
header reads still prefer official OP. Update the closed-world guard and
regressions together if changing these policies. The mock engine regression
requires every provider pair to work, one lone voter to fail, an altered bloom
to be outvoted, and a repeated agreed header to cause no upstream requests.
Backend tests cover an actual OP header, forged blooms, possible matches,
missing/error headers and preservation of log errors.

Deploy RPC first, verify its actual mounted bytes and two-provider canary,
then deploy the new autopilot image. Reverse that order for rollback: restore
autopilot before removing explicit-hash consensus. The deployed code revision
is `706f152a3c8a9cbfcf3d5fb7141787ec237c1bd9`. Only autopilot's binary changes;
the existing CoinGecko fix, configuration mount, environment and all unrelated
containers are preserved. Runtime Compose files are the live stack file, the
existing `compose-pricing.json`, and
`/Users/scep/ophis-incidents/2026-11-01-alchemy-cu/compose-cu.json`.
Use all three files for future autopilot recreation; the last override records
the new image and source build context.

Rollback configuration remains mode 0600 on the verified RAM image under
`~/.local/state/ophis/ram-pk/op-cu-20261101/before.yaml`. Sanitized measurements,
deployment identities and recovery instructions are in
`/Users/scep/ophis-incidents/2026-11-01-alchemy-cu/`. Compare observed request
rates using the published
[Alchemy CU weights](https://www.alchemy.com/docs/reference/compute-unit-costs),
not eRPC's request-count weights. The provider dashboard's actual allowance,
other account consumers and billing totals remain unverified. A reduced burn
rate does not guarantee that a finite free allowance lasts the month.

At 18:56:52 UTC, the final ten-minute rate was **53.85 estimated CU/s**, down
from **123.66 CU/s (56.5%)**. Alchemy requests fell **26.4%**, log requests
**91.9%**, and combined log/header CU **80.8%**. This uses observed traffic,
not a controlled equal-load billing comparison. Across 22 samples over 630
seconds, all indexing cursors advanced from 158980002 to 158980317 with zero
maintenance lag and zero new sanctions-fetch failures. Auctions stayed HTTP
200. Driver health was 200 in 21 samples and 503 once: both metered providers'
local request budgets were exhausted briefly, so balance checks failed closed.
The next sample and three fresh probes were 200; final alerts were empty.
Free reserve capacity remains limited during bursts. No live settlement was tested.

## October 31, 2026: ZAN quota and sanctions refresh recovery

**Operator constraint: no paid RPC plans, purchases, top-ups or overage.** Use
existing free credentials or another validated free provider. Older dated paid
capacity suggestions below are historical and do not authorize spending.

At **18:57:31 UTC**, deployed **official OP + keyed Alchemy + keyed dRPC**,
with exactly three voters, two agreeing responses and both failure behaviors
`returnError`. ZAN returned HTTP 429 with explicit package-credit exhaustion;
dRPC free-tier throttling then left the sanctions oracle with one valid RPC
vote. The orderbook logs identify `ErrConsensusLowParticipants` during
`background_refresh`. This is an RPC-capacity failure on the onchain oracle
path, not evidence that Chainalysis's hosted API is unavailable. The application
still intentionally fails open on fetch errors; restoring reads does not change
that policy.

Historical counter samples last increased at 18:34 UTC, and the sanctions alert's
last firing sample was 18:42:30 UTC, before deployment. Do not attribute that
earlier recovery to this hotfix. Fresh production oracle calls pass after the
change; the counter remains observable without restarting the orderbook. Cache
refresh is hourly, so a short quiet window does not prove a full refresh cycle.

The existing Alchemy key requires `jsonRpc.headers.Origin: https://swap.ophis.fi`.
Its free plan rejects log ranges wider than **ten blocks**. Pin
`getLogsAutoSplittingRangeThreshold: 10`; the similarly named retired setting is
not a substitute. Ten pages reproduced all 921 reference historical logs.
Every protected method, a populated successful receipt, state two million blocks
back, recent fee history and 360 requests paced at three/second matched the
independent official OP reference. This is a bounded capacity check, not proof
of remaining monthly allowance. Alchemy and dRPC each retain a separate shared
180-request/minute credit-mode limiter, autotuning disabled and one upstream
attempt. The limit counts requests, not provider billing credits.

Alchemy's vendor integration retains per-method prices when only `"*": 1` is
set. Pin every protected method, header/poller method and gas-price method to one
local unit explicitly. The initial isolated canary exhausted the local limiter
without these overrides. The regression forces Alchemy's real vendor defaults
even with mock endpoints and tests both providers' shared cross-method budgets.

The real-provider canary passed calls, the populated receipt and 921 logs with
dRPC deliberately unavailable. With official OP unavailable, calls and receipt
passed but historical logs still failed from dRPC throttling. With Alchemy
unavailable, dRPC failed to contribute quorum during that canary. These limits
remain; the new healthy pair is the availability repair. The deployed image is
unchanged and only the RPC container was recreated. Actual mounted bytes and
Docker DNS pins match the validated candidate; every other container ID stayed
unchanged.

DNS observations found Cloudflare authoritative for `optimism.io`, `drpc.org`
and `g.alchemy.com`. Different HTTPS ingress operators alone therefore do not
establish independent DNS failure domains. The RPC Compose service pins
`mainnet.optimism.io=34.149.58.211` and `lb.drpc.org=67.213.113.57`, retaining the
original HTTPS hostnames, SNI and certificate validation. These are verified
Google and dRPC ingress addresses. This prevents the shared DNS control plane
from redirecting those two voters while Alchemy continues to use DNS. The guard
checks the Compose pins as well as the RPC policy. It does not protect against
two independent ingress operators being compromised.

`shortcut:` pinned ingress addresses can change; if either becomes unreachable,
revalidate the operator's current ingress through independent DNS observations
and successful HTTPS hostname verification, then update Compose, its guard and
the regression fixture together. Recreate RPC to apply new `extra_hosts`; a
container restart alone does not change them. Verify Docker's actual
`HostConfig.ExtraHosts` and its mounted config after recreation.

Only `ALCHEMY_API_KEY` and `DRPC_API_KEY` are required by the RPC renderer; the
retired ZAN credential is optional. Driver submission remains PublicNode,
official OP and dRPC, so the two read/submission overlaps remain official OP and
dRPC. dRPC throttling still limits that overlap during settlement bursts. Do not
claim that read-only quotes validate live settlement or safe pending-nonce
propagation under load.

Before deployment, run the closed-world guard, `test-boost-rpc.py`, the pinned
engine's `test-op-erpc-quorum.py` and the renderer/health-check fixture suite.
The latter sends notification tests only to its local fixture. Require every
pair of mock voters to pass calls, receipts and split logs, and one lone voter
to fail closed. Isolated real-provider checks must include Alchemy plus official
OP with dRPC unavailable. Record dRPC-dependent failures rather than hiding them
behind an eventual successful retry.

Deploy from `/Users/scep/ophis-release-20261012-op/infra/optimism-mainnet`, after
comparing later operator edits with the reviewed baseline. Preserve the original
mounted render and candidate only in the verified RAM image under
`~/.local/state/ophis/ram-pk/op-alchemy-20261031`, mode 0600. Update source and
runtime together and recreate **RPC only**, keeping its pinned image and every
other container, signer and database unchanged. Validate the actual mount and
pins, fresh sanctions calls, local/public quotes, a populated receipt and logs,
advancing maintenance and all three indexing cursors. Observe at least ten
minutes of production traffic. Removed-upstream ratio alerts can retain their
15-minute history; do not silence them to report recovery.

The existing Nodies private account remains monthly-quota exhausted; its public
pool also failed sustained admission checks. Blockdaemon remains exhausted,
Validation Cloud returned missing historical data and OnFinality throttled.
Alchemy is contributing free capacity with finite shared allowance. Its published
[free plan](https://www.alchemy.com/pricing) includes 30M CU/month; remaining
account allowance and reset timing were not verified. Request-count overrides
in eRPC do not reduce provider billing credits. Revalidate a different free
provider or a genuinely replenished existing free account before this allowance
exhausts. Do not rotate back to a provider based on a head-only success, weaken
quorum or activate spending. The local host has about 8 GiB available and cannot
host a new OP node. Sanitized evidence and final
deployment observations are in
`/Users/scep/ophis-incidents/2026-10-31-op-rpc/`.

### Production verification at 19:15 UTC

33 samples over 16 minutes: driver and public auction HTTP 200 throughout,
maintenance lag 0–6 blocks and final lag zero, all three indexing
cursors advanced to 158937661. Local/public quotes,
a fresh oracle call, populated receipt and 44 historical logs passed. Sanctions
counters stayed at background=846 and on-demand=0. The final alert list was empty;
the retired ZAN rate alerts expired without suppression. dRPC still throttled
(0.852 capacity errors/s in the last five minutes), so free
reserve capacity remains limited. No other container restarted. Full evidence
and rollback details are in the incident directory's `diagnosis-and-recovery.md`.

## October 26, 2026, 17:49 UTC: reduce dRPC consumption

Ordinary `eth_blockNumber`, `eth_getBlockByNumber` and `eth_getBlockByHash`
requests now prefer official OP, then ZAN, with dRPC retained as the last
fallback. Every protected consensus method retains the existing ranking and
all three eligible voters; this policy only reorders the three ordinary block
methods. The closed-world guard pins the complete policy. The pinned-engine
regression proves both zero dRPC calls for a healthy ordinary header read and
successful dRPC fallback when the other two providers fail.

At 17:55 UTC, after a fresh five-minute window, dRPC numbered-block traffic fell
from 0.493 to 0.193 requests/s (**60.9%**). Total dRPC traffic fell from 3.070 to
2.719 requests/s (**11.5% observed**, not a controlled equal-load comparison).
The header difference alone projects to 777,600 fewer requests over 30 days if
the same load persists. Driver health stayed HTTP 200; maintenance returned to
zero/one-block lag after the startup transient, with zero measured
low-participant network errors. dRPC free-tier capacity errors persisted, so
this optimization does not establish reliable spare capacity.

Keep the shared 180/minute request ceiling, disabled autotuning, one dRPC
upstream attempt, 100-block historical log pages, bounded numbered-header cache
and existing in-flight request sharing. Do not cache live balances, receipts or
logs or slow block indexing to obtain an apparent saving. The three independent
event indexers still need their per-block log reads. The local `creditUnits: 1`
setting counts requests for the limiter; it is not the provider's billed-CU
counter. Use provider dashboard usage for actual consumption and billing.

Only RPC was restarted for this routing change. The actual mounted configuration
passed the guard and was checked to differ in routing policy only. Billing and
driver configuration were unchanged. Before/after evidence is in local incident
artifacts `drpc-usage-before-optimization.json`, `drpc-usage-observation.jsonl`
and `drpc-usage-deployment.json`, with the comparison in
`drpc-usage-after-optimization.json`.

## Current status at 17:10 UTC: partial mitigation, capacity still required

The dRPC change below is deployed but **does not establish reliable redundancy**.
Sustained traffic exposed HTTP 429 `You reached free plan rate limit, please
upgrade to paid plan` that low-rate probes missed. At 17:09:46 the preceding
five-minute window had 2.904 dRPC requests/s, 0.933 capacity errors/s (~32.1%),
plus 0.041 server errors/s. Official OP and ZAN kept quorum; measured
low-participant network errors remained zero and maintenance stayed near head.
dRPC contributes successful reads, improving on the completely dead Blockdaemon
lane, but another provider's failure can still interrupt service during its
rate-limited periods. Empty alerts or successful quotes do not close this risk.

The recommended next step is usable paid archive capacity on this validated dRPC
route, with prepaid/bounded spend and automatic recharge disabled, or an owned
OP node on a suitably provisioned existing host. The
[published Pay as You Go price](https://drpc.org/docs/pricing/plans) is $6 per
million requests. At 2.904 requests/s, this lane projects to about $45.16 over
30 days; its 180/minute ceiling corresponds to $46.66, before driver submission,
other account consumers, taxes or changes in pricing/usage. This is an estimate,
not a verified billing cap. Obtain operator budget approval before funding or
changing the request tier; none was activated during this investigation.

The present local host has only about 31 GiB free, so it is not provisioned for
an OP node. No zero-cost replacement has passed both correctness and sustained
capacity checks. Do not claim that slowing a dead provider's polling or reducing
quorum fixes the missing capacity. The earlier 17:01 checks prove response
correctness and deployment, not sustained free-tier capacity.

## October 26, 2026, 17:01 UTC: replace Blockdaemon with keyed dRPC

Current voters are **official OP, ZAN and keyed dRPC**. Blockdaemon returned
HTTP 429 `Quota limit exceeded`; its growing sampled-head lag was a consequence
of failed polling. The existing dRPC account was usable and replaced Blockdaemon
in both eRPC reads and driver transaction submission at 17:01:35 UTC. No billing
setting, signer, image, database cursor or consensus threshold changed. Only the
existing RPC and driver containers were restarted.

dRPC rejected 200/500-block log ranges, despite an error message referring to
10,000 blocks. Set its existing `getLogsAutoSplittingRangeThreshold` to **100**.
Five 100-block pages reproduced all 281 historical reference logs. Fixed-block
state, a populated transaction and successful receipt matched official OP and
ZAN; state two million blocks back also passed. Recent fixed-block fee-history
responses matched all three providers. Do not replace this with a head-only
probe or restore the unsupported 500-block setting.

Both live two-voter combinations (dRPC plus official OP, and dRPC plus ZAN)
passed calls, historical logs and receipts through the pinned eRPC engine with
the other voter deliberately unavailable in an isolated canary. Initial cold
startup can return a fail-closed low-participant error before pollers warm.
The local quorum regression rejects a lone voter and proves 100-block dRPC log
splitting and the shared cross-method budget. Renderer/health-check regression:
47 passed, zero failed, with external messaging blocked during the test.

Preserve exactly three independent voters, threshold two and both `returnError`
behaviors. Driver submission uses PublicNode, official OP and dRPC, retaining
two read/submission overlaps. Keep the shared **180 requests/minute** limiter,
credit-count mode, autotuning disabled and one upstream attempt. The guard pins
the keyed Optimism endpoint, log-page size and these invariants. The renderer
requires `ZAN_API_KEY` and `DRPC_API_KEY`; retired Blockdaemon/Tenderly keys are
optional. No `Origin` header is needed for this backend key.

The [published dRPC free allowance](https://drpc.org/docs/howitworks/ratelimiting)
is 210M CU per 30-day period. At the
[published 20 CU/request](https://drpc.org/docs/pricing/compute-units), the limiter
ceiling permits 155.52M CU over 30 days, before other account consumers and
driver submission. Remaining account allowance and reset timing were not
verified. This is restored contributing capacity, not an unlimited-capacity
guarantee. Check actual dashboard usage; do not enable paid overage implicitly.

The live deployment checkout is
`/Users/scep/ophis-release-20261012-op/infra/optimism-mainnet`. Tested source is
`/Users/scep/ophis-op-rpc-recovery-20261026`. Both actual mounted files were
compared with the secure candidates, and the mounted RPC file passed the guard.
Credential-bearing candidates and rollback files are mode 0600 on the verified
RAM image under `~/.local/state/ophis/ram-pk/op-drpc-20261026`; never move them to
Git or a disk-backed evidence folder. The driver render changed only its retired
submission URL, preserving all signer and unrelated settings.

After a provider change, require at least ten minutes of real traffic with
contributing voters, bounded upstream errors, healthy driver, advancing auction
and all three database cursors, plus local/public quotes and a populated receipt
through the production proxy. Lag alerts for a removed voter clear after stale
series disappear; ratio alerts retain up to 15 minutes of old traffic. A planned
proxy restart also raises the existing five-minute restart warning. Do not
silence these rules to claim recovery.

Sanitized evidence is in
`/Users/scep/ophis-incidents/2026-10-26-op-unichain/drpc-{complete-preflight-1654,live-canary-1656,deployment-1700,production-checks-1703}.json`
and `drpc-observation-1702.jsonl`. The dated sections below describe earlier
topologies. A durable OP node would remove one external quota dependency; the
operator host currently has only about 31 GiB free, so no new node was started
on it during this recovery.

## October 26, 2026, 13:53 UTC: Blockdaemon allowance exhausted

The morning Blockdaemon replacement is now exhausted too. At 13:57 UTC a direct
probe returned HTTP 429 `Quota limit exceeded`; the preceding five-minute eRPC
window showed capacity errors on every Blockdaemon request. Official OP and ZAN
returned the same head. Public version, auction and a 0.05 WETH→USDC quote still
passed; essential maintenance was one block behind. This is degraded service
with two contributing voters and no spare, not restored redundancy. Blockdaemon's
last sampled head ages when its polls fail; the growing lag is not proof of a
provider chain fork.

The 13:53:22 lag notification follows a condition active since 13:38:22 plus its
15-minute hold. Do not wait another hour after a raw quota failure. Restarting
eRPC, increasing its limiter or retrying cannot replenish account allowance.
The 180/minute ceiling can still admit 259,200 requests/day (7,776,000 over 30
days); it limits rate, not monthly quota, and does not cover driver submissions.

Restore this account's usable allowance or validate a genuinely funded/available
replacement before changing providers. Preserve exactly three independent read
voters, two agreeing responses and both `returnError` behaviors. Replacing the
read voter also reaches the driver submission targets, renderer/key validation,
closed-world guard, regression fixtures and deployment source. Require two
usable providers in the read/submission overlap: with Blockdaemon exhausted,
only official OP currently contributes to both. Working quotes do not establish
safe pending-nonce behavior during a new settlement burst. Do not patch only
eRPC or remove its third voter to clear the alert.

Run the protected-method, historical-log and populated-receipt preflight in the
morning procedure below; verify the actual mounted config and observe at least
ten minutes of real traffic after a change. The earlier Nodies and other rejected
providers remained unverified replacements at 14:02 UTC. The later dRPC recovery
above supersedes that capacity assessment. Do not activate paid capacity without
operator authorization.

The separate sovereign-canary failure is Unichain HTTP 530, not this OP warning.
Local incident evidence and the full recovery procedure are in
`/Users/scep/ophis-incidents/2026-10-26-op-unichain/2026-10-26-1353-diagnosis-and-recovery.md`.

## October 26, 2026: Nodies monthly allowance exhausted

Nodies returned HTTP 429: `Request limit exceeded, total free requests allowed
per month: 4000000`. Replace it with the existing keyed Blockdaemon lane in both
eRPC reads and driver submission. Current read providers are official OP, ZAN and
Blockdaemon. Keep exactly three voters, two agreeing responses and both failure
behaviors set to `returnError`. The shared 180/minute ceiling, 500-block log pages
and one upstream attempt remain. This rate ceiling does not cap monthly credits;
confirm remaining allowance in the provider dashboard before claiming permanence.
Blockdaemon's [published limits](https://docs.blockdaemon.com/docs/rate-limits)
include 5 requests/second on its free plan. In production this replacement still
hits burst throttles; treat it as restored redundancy with limited capacity,
not a permanent capacity fix. PublicNode rejects archive access, Validation Cloud
returns pruned historical state, and Alchemy's current free plan rejects log
queries wider than ten blocks. Do not substitute these based on a head-only probe.

Validate every protected method at fixed blocks, including populated historical
logs and receipts. Run the guard and quorum regression before deployment. Keep
credential-bearing rollback files on the verified RAM disk. Apply only the RPC
and driver config changes, then restart those existing containers. Check their
actual mounts, public quotes, driver health, upstream errors and firing alerts
under at least ten minutes of real traffic. A hand probe cannot establish capacity.
Do not reduce quorum or activate paid capacity to clear an alert.

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

The correction yields when more than 200 historical blocks remain (5,000 at the
time; see the 2026-11-02 note on catch-up budgets). It then
advances ordinary catch-up in hash-verified checkpoints of at most 16 blocks,
requiring the sampled head before reporting success. The no-reorg path accepts head drift
after partial progress instead of replaying history. Historical checkpoints need
one header; the 64-block event overlap remains. Four-request concurrency,
contiguous-prefix handling, ten-second cooldown for RPC/storage failures, and
fail-closed RPC consensus remain. Successful partial checkpoints resume on the
next maintenance retry, so fast chains cannot outrun an artificial cooldown.
The regression follows a persisted empty-range restart through
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
fetch. Historical maintenance checkpoints at most 200 blocks per attempt,
retains the 64-block reorg overlap, and avoids fetching moving-tip headers until
the final historical chunk. Tail checkpoints process at most 16 blocks at a time.
It stops consuming RPC pages on the first error and backs off that indexer for
ten seconds. Successful partial checkpoints return a distinct incomplete error
without that cooldown, so essential maintenance cannot publish a current auction
from them while catch-up continues on fast chains.
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

## 2026-11-02: catch-up attempts must fit the log budget

eRPC 0.2.0 splits every `eth_getLogs` at the smallest upstream
`getLogsAutoSplittingRangeThreshold` (Alchemy's 10 blocks) and sends each page
to all three voters. A historical attempt saves its checkpoint only after its
last page, and log pages are not cached, so a failed page restarts the attempt.
At 5,000 blocks an attempt was 500 pages per indexer, 1,500 per voter across the
three indexers, far over the 180/minute dRPC and Alchemy budgets: after an
outage of roughly 15 minutes or more, catch-up could retry forever without
advancing. `MAX_HISTORY_BLOCKS` is now 200 (60 calls per voter per attempt), and
`assert-erpc-failclosed.py` fails CI if the two numbers drift apart again.

Limit: a full re-index from an empty database is still impractical at 10-block
pages within these budgets (months of OP history is millions of pages). Treat a
database loss as needing more log capacity first, not just time.
