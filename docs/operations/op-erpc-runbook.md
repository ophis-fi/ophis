# Optimism eRPC consensus — operational runbook

**Audience:** Ophis on-call operator responding to an OP stack RPC issue.
**Last updated:** 2026-05-19 (PR #130 — OP eRPC proxy clone).

## System model in 60 seconds

The OP stack reads chain state via an **eRPC proxy** (`rpc-proxy`
container) that fans every consensus-protected request out to **3
upstreams**:

| Upstream | Endpoint | Failure domain | Notes |
|---|---|---|---|
| `publicnode-op` | `https://optimism-rpc.publicnode.com` | Allnodes | CDN: Cloudflare — **the ONE permitted CF lane**; auth: none (free tier); **archive-gated at ~128 blocks from head — this gap covers `eth_getLogs` AS WELL AS `eth_getTransactionReceipt`.** Deeper reads return jsonrpc `-32602` "Archive requests require a personal token", which eRPC buckets as the GENERIC `ErrEndpointClientSideException`, not an auth error. Cause of the 2026-08-23 settlement-indexer outage |
| `zan-op` | `api.zan.top` | ZAN (Ant Digital) | CDN: none detected (non-CF); auth: keyed (`${ZAN_API_KEY}`); serves all protected methods; **slow: p50 ~1.1s, p95 ~4.6s against its own 4s timeout** |
| `official-op` | `https://mainnet.optimism.io` | OP Labs | CDN: none (GCP LB, `via: 1.1 google`), non-CF; auth: none (free tier); archive-capable on BOTH `eth_getLogs` and receipts. **⚠️ DEGRADED STOPGAP: ~50% HTTP 429 (per-IP rate limit) even at ~4 req/s.** Admitted 2026-08-23 to replace `validationcloud-op` (HTTP 401 since 08-18, quota resets ~09-01). Replace with a keyed archive lane |

The lane set is rebuilt often — six times in six weeks to 2026-08-18, and
every rebuild but one was forced by a provider running out of quota or
credentials. **The authoritative, dated list is the header of
`infra/optimism-mainnet/configs/erpc.yaml.tmpl`**; treat any table in this
runbook as secondary and check that header first.

**Hard invariant: at most ONE upstream may be Cloudflare-fronted.** publicnode
holds that slot. A 2-upstream subset sharing one CDN/DNS could satisfy quorum
alone under a single control-plane compromise. Measured 2026-08-18: dRPC, 1RPC,
Nodies, BlastAPI, Omnia, BlockPI, Lava and Tatum are all CF-fronted and are
therefore ineligible while publicnode is in the set.

**Consensus policy:** `maxParticipants=3`, `agreementThreshold=2`,
`lowParticipantsBehavior=returnError` on every protected group.
`disputeBehavior=preferBlockHeadLeader` for the `eth_call`/`eth_getBalance` and
`eth_getLogs` groups, and `returnError` for `eth_getTransactionReceipt`.
Audit-required to defeat fork-view-poisoning: no single hostile upstream can
influence outcomes **provided at least three lanes can actually serve the
method**. When the count of capable lanes equals `agreementThreshold`, that
protection is gone for that method — see the rule of thumb in the template
header.

**Fail-closed by design:** any consensus failure surfaces as a
JSON-RPC error to the caller. Callers (autopilot/driver/orderbook)
handle this via app-layer retry. System functions correctly under
transient consensus failures, but log volume is elevated.

**Port assignment** (Mac-mini coexistence with HL stack):

| | HL | OP |
|---|---|---|
| Host-port for eRPC | 4000 | **4001** |
| Internal docker network port | 4000 | 4000 |
| `service:port` other services hit | `rpc-proxy:4000` | `rpc-proxy:4000` |

The internal port stays at 4000 on both stacks because each compose
project has its own bridge network. Only the host-bound port differs.

## Alert decoder

OP alerts **are** deployed: `infra/optimism-mainnet/observability/alerts.yml`
is bind-mounted straight into Prometheus (no render step).

Every eRPC rule in the table below — all eleven — has both a firing case and a
silence case in `alerts_test.yml`, and each is verified by mutation: rewriting
any of them to never-fire or always-fire makes the suite fail, and so does
moving any ratio threshold in either direction. **The other rules in that file
(settlement, gas, host, sanctions) are NOT covered yet**; for those, silence
still proves nothing.

| Alert | Fires when | Severity |
|---|---|---|
| `OphisOpErpcUpstreamEffectivelyDead` | one lane fails >95% of requests for 10m, any error code | **critical** |
| `OphisOpErpcUpstreamCredentialFailing` | auth/billing/4xx errors on a lane | **critical** |
| `OphisOpErpcUpstreamRateLimitedDead` | >90% `ErrEndpointCapacityExceeded` for 30m | warning |
| `OphisOpErpcUpstreamPhantomParticipant` | >60% of a lane's requests short-circuit on stale head for 2h | warning |
| `OphisOpErpcUpstreamBlockHeadLagging` | a lane is >5 blocks behind the median for 15m | warning |
| `OphisOpErpcNetworkFailsafeTimeouts` | 12s network budget exhausted before any upstream answers | **critical** |
| `OphisOpErpcConsensusLowParticipantsHigh` | fewer than `agreementThreshold` lanes answering | warning |
| `OphisOpErpcConsensusDisputeHigh` | lanes disagreeing | warning |
| `OphisOpErpcConsensusFailureCritical` | sustained consensus failure | **critical** |
| `OphisOpErpcProxyRestarted` | rpc-proxy process started <5m ago (i.e. it crashed) | warning |
| `OphisOpERPCDown` | `up{job="rpc-proxy"}==0` for 3m | **critical** |

⚠️ **Silence is not health.** Two of these were written for incidents they then
failed to catch: `OphisOpErpcUpstreamCredentialFailing` matched
`ErrEndpointUnauthorized` while eRPC emits `ErrEndpointClientSideException` for a
provider 401 (2026-08-18), and `OphisOpErpcUpstreamRateLimitedDead` dilutes below
its ratio threshold when rejection is burst-correlated (2026-08-09). If you add or
edit a rule, add a case to `alerts_test.yml` and prove it fails when the rule is
mutated back.

## Diagnostic playbook

### Step 1 — identify which upstream is degraded

```bash
# Direct probe each upstream — measure latency + correctness
for ep in \
  https://mainnet.optimism.io \
  https://optimism-rpc.publicnode.com \
  https://rpc.ankr.com/optimism; do
  printf "%-50s " "$ep"
  time cast block-number --rpc-url "$ep" 2>&1
done
```

Look for:
- Block-number divergence > 5 blocks → one upstream is structurally lagging
- Timeout / 429 → rate-limited or rate-quota exhausted (Ankr public has
  the lowest rate budget of the three — watch this one first)
- 5xx / connection refused → provider outage

### Step 2 — confirm with eRPC's own metrics

```bash
# From inside the docker network
docker run --rm --network optimism-mainnet_default \
  curlimages/curl:latest -s http://rpc-proxy:4000/metrics \
  | grep -E "erpc_(consensus_errors_total|upstream_request_errors_total|upstream_block_head_lag)" \
  | grep "evm:10"
```

`erpc_upstream_block_head_lag` shows how many blocks behind median each
upstream is. > 5 is suspicious on OP (2s blocks → 10s+ lag).
`erpc_upstream_cordoned == 1` means eRPC has sit-out-penalized the
upstream (auto-recovers after `sitOutPenalty = 30m`).

From the host (faster than spinning up curlimages):
```bash
curl -s http://127.0.0.1:4001/metrics | grep "evm:10"
```

### Step 3 — escalation tree

```
upstream X failing
├── single upstream, transient (rate-limit, brief outage)
│   └── ACTION: nothing. eRPC sit-out + auto-recovery handle it.
│              The other 2 upstreams maintain consensus.
│
├── single upstream, sustained (provider down for hours)
│   └── ACTION: hot-swap the upstream. See "Provider hot-swap" below.
│
├── two upstreams down simultaneously (real incident)
│   └── ACTION: emergency. See "Critical incident: 2-of-3 down" below.
│
└── all three down
    └── ACTION: OP chain is likely down OR your egress is broken.
               Check https://status.optimism.io/ first.
```

## Provider hot-swap

Recovery from "single upstream sustained failure": replace the failing
upstream with a known-healthy candidate.

**Pre-vetted candidates** — ⚠️ this list is from 2026-05-19 and has ROTTED.
Re-probed 2026-08-18: BlastAPI and Omnia are now Cloudflare-fronted, so both
are ineligible while publicnode holds the CF slot. Ankr no longer serves a
keyless endpoint. Probe for `cf-ray`/`server` headers AND `dig NS` before
admitting anything:

- `https://op-mainnet.public.blastapi.io` — Blast API, distinct DNS
- `https://endpoints.omniatech.io/v1/op/mainnet/public` — Omnia public
- `https://optimism.api.onfinality.io/public` — OnFinality public
  (CAUTION: HL's OnFinality endpoint returned empty `eth_call` — re-probe)

**Excluded** (do NOT add without thorough re-probing first):
- `https://optimism.llamarpc.com` — **shares Cloudflare DNS with
  official-op**. Adding this collapses the 2-of-3 consensus protection
  under a CF control-plane incident. Hard ban.
- `https://1rpc.io/op` — HL equivalent had stuck `finalized` tag;
  unverified on OP, treat as suspect until probed.
- `https://optimism.drpc.org` — HL equivalent had "intrinsic gas too
  high" flake on `eth_call`; unverified on OP.

**Swap procedure:**

1. Edit `infra/optimism-mainnet/configs/erpc.yaml.tmpl`:
   - Update the failing upstream's `endpoint:` line
   - Update its `id:` if the operator identity changed
   - Update the failure-domain table in the header comment with the
     date + reason

2. Re-render and recreate rpc-proxy:
   ```bash
   # the LIVE deploy worktree — /Users/scep/greg is a stale object store,
   # rendering there changes nothing that is mounted. Confirm with:
   #   docker inspect optimism-mainnet-rpc-proxy-1 --format '{{range .Mounts}}{{.Source}}\n{{end}}'
   cd /Users/scep/greg-wt/op-deploy-0730/infra/optimism-mainnet
   ./render-configs.sh
   docker compose up -d --force-recreate --no-deps rpc-proxy
   ```

3. Verify consensus is succeeding:
   ```bash
   sleep 30  # let it warm up
   curl -s http://127.0.0.1:4001/metrics \
     | grep "erpc_consensus_total" | grep "outcome=\"success\""
   ```

4. Open a follow-up PR with the change + a one-line entry in the
   failure-domain table header. Re-run the
   `feedback_audit_mainnet_contract_wiring` audit gate (Codex +
   sharp-edges) because the threat model on consensus picks is
   security-relevant.

## Critical incident: 2-of-2 upstreams down

If two upstreams are down simultaneously, every consensus call fails.
Driver/orderbook/autopilot stall on every block-tip read. Settlements
cannot broadcast.

**Options (in order of preference):**

1. **Wait** — if one is rate-limited and the other is transiently slow,
   recovery within 5-10 min is normal.

2. **Add a 4th upstream** — emergency single-upstream addition from the
   pre-vetted candidates above. This doesn't weaken the consensus
   invariant (still 2-of-N agreement, just N=4). Re-probe the candidate
   first.

3. **Lower `agreementThreshold` to 1** — **EMERGENCY ONLY, NOT
   AUDIT-COMPLIANT.** Disables fork-view-poisoning resistance. Use
   only if (a) the chain is genuinely down for a long stretch AND
   (b) the alternative is multi-hour zero-settlement window. Edit
   `erpc.yaml.tmpl`:
   ```yaml
   agreementThreshold: 1   # EMERGENCY — revert as soon as ≥2 upstreams healthy
   ```
   Re-render + restart. Set a calendar reminder to revert within 1 hour.
   Open an incident-postmortem PR.

## Bypass: OP_RPC_INTERNAL override

`infra/optimism-mainnet/.env` accepts an `OP_RPC_INTERNAL` env var.
If non-empty, **all chain-reading services route via that single URL,
bypassing eRPC + consensus entirely**. Intended for emergency bypass
when eRPC itself misbehaves AND a known-good single provider exists.

`render-configs.sh` prints a loud warning at run time when this is
set, so a forgotten dev value can't sit unnoticed.

To re-enable proxy mode: remove the `OP_RPC_INTERNAL` line from `.env`
(or set it empty) and re-run `./render-configs.sh && docker compose up
-d`.

## Caller guidance — prefer explicit block numbers over `latest`

Inherited from HL runbook (Codex Cyber post-merge recommendation,
PR #71). Same logic applies on OP: the strict-consensus failsafe +
naturally-drifting upstream tips mean `"latest"`-tag queries dispute
frequently. For numbered block queries, all upstreams return identical
data — no disputes (OP block contents are deterministic per L2 block
number).

**When writing new code paths in autopilot / driver / orderbook:**

- ❌ Avoid `eth_getBlockByNumber("latest", ...)` if you can resolve a
  specific block number first
- ✅ Prefer the pattern: cache the head block number from a single
  source (e.g., `eth.current_block().borrow().number`), then issue
  subsequent reads against that specific block number
- ✅ For `eth_call`, default to passing the current block number
  explicitly rather than letting it default to "latest"

## `eth_getLogs` tip-lag (operational gotcha)

Documented 2026-05-20 during Phase 3.1 E2E verification work
(`docs/operations/e2e-swap-verification.md`).

**Symptom:** `eth_getLogs` queries within ~5 blocks of tip frequently fail
with `ErrConsensusLowParticipants`, returning errors like:

```
ErrUpstreamBlockUnavailable (tenderly-op)
ErrUpstreamsExhausted      (ophis-self-op)
e3b0c44... = keccak(empty) (publicnode-op)
```

**Root cause:** RPC providers serve `eth_blockNumber` from the consensus
head immediately, but `eth_getLogs` requires the block to be ingested into
the log index, which lags by 2–10 seconds depending on provider. With
2-of-3 strict consensus, all three indexes need to be caught up — the
slowest one bounds you.

Indexer lag varies per-upstream over time (initial-2026-05-13 snapshot
of self-hosted op-node took ~2s longer than public providers; that
delta has since narrowed as the node's pruning settled). Don't assume
any single upstream is "always the laggard." Consult the live picture
in `erpc_upstream_block_head_lag{network="evm:10"}` before diagnosing.

**Production impact:** None on settlement. The driver uses `eth_call` +
`eth_sendRawTransaction` (submission bypasses eRPC anyway), neither of
which hits the log index. Only retrospective audit/indexing paths are
affected.

**Workaround for callers:**

- Scan with `toBlock = currentBlock - 5` (or `- 10` for safety margin)
- For the `verify-e2e-swap.sh` harness this is `TIP_LAG_BLOCKS=5`
- For long-running indexers, use `safe` block tag if the provider supports
  it (publicnode does; tenderly is hit-and-miss)

**When to investigate vs. just wait:**

- If lag clears within ~30s of block production: normal, no action
- If lag persists for >5 minutes on the same block: one upstream's
  indexer is stuck — follow §"Step 3 — escalation tree" above

## Submission path (NOT consensus-protected)

The driver races settlement broadcast in parallel via 3
`[[submission.mempool]]` entries in `driver.toml.tmpl`:

- `https://optimism-rpc.publicnode.com`     (PublicNode / Allnodes)
- `https://mainnet.optimism.io`             (OP Foundation gateway)
- `https://optimism.gateway.tenderly.co`    (Tenderly)

This is intentional: tx submission needs nonce-coherent endpoints, not a
load-balanced fan-out (so all 3 see the same nonce-N tx). `select_ok` in
`crates/driver/src/domain/mempools.rs` keeps the first acknowledgement
and lets the others run to completion (any tx broadcast to the OP
sequencer eventually lands; nonce-conflict re-broadcasts are no-ops).

If one mempool goes down, the other two still broadcast → settlements
land. If two go down, the third still works → degraded but functional.
Edit `[[submission.mempool]]` in `driver.toml.tmpl`, re-render, restart
driver.

**Receipt-poisoning protection:** receipts read via `eth_getTransactionReceipt`
go through the eRPC consensus path (the method is included in the
consensus `matchMethod` regex). So a hostile submission RPC lying about
inclusion is caught: autopilot sees the tx never landed via
consensus-protected reads, retries.

**Why self-hosted is NOT in this list (audit A1, 2026-05-21):** The
Aleph VM at `100.77.53.81:8545` was previously the 4th (and primary)
submission endpoint, prepended on the grounds that it would win the
include-race by latency. But any process with root on that VM could
observe our signed settlement calldata in real time — a single point of
MEV-leak failure. We dropped it from submission (keeping it in eRPC
consensus reads, which leak nothing). An attacker now needs to
compromise ≥2 of the 3 distinct corporate operators above to reliably
front-run our settlements. The latency edge we lose is empirically
not load-bearing — the next-block inclusion rate stayed ≥99% in
Phase 2 telemetry.

**MEV leakage residual:** a hostile submission RPC can still leak signed
calldata to a private searcher before propagation. The 3-way race over
distinct operators forces the attacker to be on (or have suborned)
≥2-of-3 of them to race us reliably. Roadmap item: add a private/dark
mempool (Conduit sequencer-direct, OP private pool, or Flashbots-style
relay) to reduce calldata observability to zero on the dominant path.

## Related references

- `infra/optimism-mainnet/configs/erpc.yaml.tmpl` — config + failure-domain map
- `docs/operations/hl-erpc-runbook.md` — sibling HL runbook (consult for shared patterns)
- `docs/operations/distributed-tracing.md` — Jaeger collector setup (PR #134)
- `docs/architecture/2026-05-18-submitter-pk-custody-adr.md` — driver-submitter PK custody (Tier 1/1.5/2)
