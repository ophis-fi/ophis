# Phase 4 final audit re-sweep — 2026-05-20

**Audited by:** Codex CLI 0.130.0 + sharp-edges-analyzer agent (parallel)
**Scope:** session deltas since the prior audit (eRPC threshold change,
monitoring script, new alert rules).
**Status:** 3 of 4 MED findings applied; 1 MED queued as follow-up
(task #119). No HIGH findings.

## Applied in this PR

### N3 (MED) — `OphisOpSimulationRevertSpike` false-page during hot-reload

Both audits flagged that the alert's `for: 10m` window would fire on
back-to-back driver restarts during a config roll. Driver hot-reload
re-simulates the in-flight auction queue against potentially-stale
balance snapshots, producing a transient sim-revert burst.

**Fix:** added `and on(instance) (time() -
process_start_time_seconds{job="driver"}) > 300` to the alert expression.
Also extended `for: 10m` → `for: 15m` for additional headroom. Driver
must be up for ≥5min before the alert can trip.

### N4 / N3-codex (MED) — `OphisOpMatchedUnsettledGrowth` was the wrong metric

Codex audited the underlying source: `gp_v2_autopilot_runloop_matched_unsettled`
increments for ranked NON-WINNING solution orders, not "broadcast but
never landed". My alert would fire constantly under normal
auction-competition traffic.

**Fix:** REMOVED the alert. Replaced with a comment in `alerts.yml`
explaining the metric is competition-noise. A proper alert for
"submitted-and-winning-but-never-observed" needs a different metric
(possibly a new one in `apps/backend/crates/driver`); left as roadmap.

### N2 (MED) — `check-settlement-buffer.sh` silent failure on RPC errors

Both audits flagged that `cast call 2>/dev/null | awk '{print $1}'`
+ `|| bal=0` would silently report "$0 in buffer" on RPC failures.
Monitoring blind spot during exactly the incident where you need
accurate state.

**Fix:** wrapped each `cast call` in a per-token try/except. On
failure: increment `PROBE_FAILURES`, set `status: "error"` in the
JSON output, push a separate `ophis_settlement_buffer_probe_failures`
counter to pushgateway (alertable). Added `command -v bc` dependency
check (Codex noted).

## Queued as follow-up — task #119

### N1 (MED) — `disputeThreshold: 100` enables sustained-low DoS

Both audits converged on this: a hostile upstream can sit just below
threshold:100 indefinitely (or burst 100 disputes then sit out 5m,
repeat) — sustained ~95% DoS duty cycle on eth_call /
eth_getTransactionReceipt. Driver fails-closed (safe — no poisoning)
but settlement-broadcast halts during the attack window.

**Proposed fix (queued):** split consensus rules by method threat
surface. Lower threshold (30) for stable security-critical reads
(eth_call, eth_getBalance). Higher threshold (100+) only for tip-
lagging observation reads where natural indexer drift inflates
disputes. Plus add per-upstream dispute-rate alert so operators can
manually evict misbehaving upstreams the system doesn't self-recover
from.

Not blocking ship — at current traffic the residual attack window
hasn't materialized. Filed as task #119.

## Convergent assessment

Both audits independently concluded "shippable, no HIGH findings on
deltas." The 3 applied fixes close the operational hygiene issues
(false-page risk, monitoring blind spot, wrong-metric alert). The
deferred N1 is a defense-in-depth refinement worth doing pre-meaningful-
TVL but not pre-launch.

## Aggregate session readiness

End-of-session state (PR #166, 10 commits):

| Layer | State |
|---|---|
| eRPC consensus (eth_call back in 2-of-3, threshold:100) | ✅ shipped, verified live |
| FE link-bug fix + allow-list inversion | ✅ shipped (`index-DfqhU1eY.js` live) |
| /api/intent CF function | ✅ working (post-functions/ deploy script) |
| Settlement buffer monitoring | ✅ ready (check-settlement-buffer.sh) |
| Telegram alerts | ✅ live (17 rules, observability stack healthy) |
| Phase 3.1 E2E (first real OP swap) | ✅ proven on-chain (tx 0x4148d94f…) |
| Phase 3.3 / 3.4 / 3.5 / 3.8 docs + findings | ✅ documented |
| DR drill VM2 | ✅ procedure documented, execution pending user SSH access |
| CIP-75 fee sweep | ✅ monitoring + design-decision queued for post-launch |

**Frontend / branding / design sprint:** unblocked. The infra work
captured in this PR should not need further iteration before the FE
focus begins.
