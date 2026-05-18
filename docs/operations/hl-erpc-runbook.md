# HyperEVM eRPC consensus — operational runbook

**Audience:** Ophis on-call operator responding to an HL eRPC alert.
**Last updated:** 2026-05-18 (PR #76 alerts shipped + Codex post-merge recommendations).

## System model in 60 seconds

The HL stack reads chain state via an **eRPC proxy** (rpc-proxy container) that fans every consensus-protected request out to **3 upstreams**:

| Upstream | Endpoint | Failure domain | Notes |
|---|---|---|---|
| `purroof-hl` | `https://rpc.purroofgroup.com` | Vultr | Most reliable in steady state (10/10 isSolver eth_call) |
| `official-hl` | `https://rpc.hyperliquid.xyz/evm` | AWS CloudFront | 100 req/min/IP cap on public tier |
| `hypurrscan-hl` | `https://rpc.hypurrscan.io` | AWS Tokyo | HL-native operator |

Replaced `hyperlend-hl` 2026-05-18 (PR #70) — chronic rate-limit. Reliability map + exclusion rationale live in `infra/hyperevm-mainnet/configs/erpc.yaml.tmpl` header.

**Consensus policy:** `maxParticipants=3`, `agreementThreshold=2`, `disputeBehavior=returnError`, `lowParticipantsBehavior=returnError`. Audit-required to defeat fork-view-poisoning (any 1 hostile upstream cannot influence outcomes).

**Fail-closed by design:** any consensus failure surfaces as a JSON-RPC error to the caller. Callers (autopilot/driver/orderbook) handle this via app-layer retry. **System functions correctly under transient consensus failures**, but log volume is elevated. Distinguishing "expected transient" from "real incident" is the alert system's job.

## Alert decoder

| Alert | What it means | Default severity |
|---|---|---|
| `OphisHlErpcConsensusLowParticipantsHigh` | >2 of 3 upstreams failing to respond within retry budget for a method | warning |
| `OphisHlErpcConsensusDisputeHigh` | Upstreams returning *different* responses for the same request | warning |
| `OphisHlErpcConsensusFailureCritical` | >50% of consensus operations failing for 5min | **critical** |

All three monitor `erpc_consensus_errors_total{network="evm:999"}`. Each alert's annotation includes the immediate diagnostic commands inline — read them before running the steps below.

## Diagnostic playbook

### Step 1 — identify which upstream is degraded

```bash
# Direct probe each upstream — measure latency + correctness
for ep in \
  https://rpc.purroofgroup.com \
  https://rpc.hyperliquid.xyz/evm \
  https://rpc.hypurrscan.io; do
  printf "%-45s " "$ep"
  time cast block-number --rpc-url "$ep" 2>&1
done
```

Look for:
- Block-number divergence > 5 blocks → one upstream is structurally lagging
- Timeout / 429 → rate-limited or rate-quota exhausted
- 5xx / connection refused → provider outage

### Step 2 — confirm with eRPC's own metrics

```bash
# From inside the docker network
docker run --rm --network hyperevm-mainnet_default \
  curlimages/curl:latest -s http://rpc-proxy:4001/metrics \
  | grep -E "erpc_(consensus_errors_total|upstream_request_errors_total|upstream_block_head_lag)" \
  | grep "evm:999"
```

`erpc_upstream_block_head_lag` shows how many blocks behind median each upstream is. > 5 is suspicious.
`erpc_upstream_cordoned == 1` means eRPC has sit-out-penalized the upstream (auto-recovers after `sitOutPenalty = 30m`).

### Step 3 — escalation tree

```
upstream X failing
├── single upstream, transient (rate-limit, brief outage)
│   └── ACTION: nothing. eRPC sit-out + auto-recovery handle it.
│              The other 2 upstreams maintain consensus. Watch
│              `OphisHlErpcConsensusLowParticipantsHigh` only fire
│              if a SECOND upstream also fails simultaneously.
│
├── single upstream, sustained (provider down for hours)
│   └── ACTION: hot-swap the upstream. See "Provider hot-swap" below.
│              Re-evaluate from the reliability map in
│              infra/hyperevm-mainnet/configs/erpc.yaml.tmpl.
│
├── two upstreams down simultaneously (real incident)
│   └── ACTION: emergency. See "Critical incident: 2-of-3 down" below.
│
└── all three down
    └── ACTION: HL chain is likely down / DNS is broken. Check
               https://status.hyperliquid.xyz/ or HL discord first.
```

## Provider hot-swap

Recovery from "single upstream sustained failure": replace the failing upstream with a known-healthy candidate.

**Pre-vetted candidates** (probed 2026-05-18, may need re-probe before use — see reliability map for exclusion reasons):
- `999.rpc.thirdweb.com` — Thirdweb, CF-fronted
- `https://hyperliquid.api.pocket.network` — Pocket Network (single-canary node — beware)
- `https://hyperliquid-json-rpc.stakely.io` — Stakely, CF-fronted

**Excluded** (do NOT add without re-probing first):
- `https://hyperliquid.drpc.org` — flake: "intrinsic gas too high" on eth_call
- `https://hyperliquid.api.onfinality.io/evm/public` — 429 on public tier
- `https://1rpc.io/hyperliquid` — finalized-tag silently stuck (drift +26 blocks)

**Swap procedure:**

1. Edit `infra/hyperevm-mainnet/configs/erpc.yaml.tmpl`:
   - Update the failing upstream's `endpoint:` line
   - Update its `id:` if the operator identity changed
   - Update the reliability-map header comment with the date + reason

2. Re-render and recreate rpc-proxy:
   ```bash
   cd /Users/scep/greg/infra/hyperevm-mainnet
   ./render-configs.sh
   docker compose up -d --force-recreate --no-deps rpc-proxy
   ```

3. Verify consensus is succeeding:
   ```bash
   sleep 30  # let it warm up
   docker run --rm --network hyperevm-mainnet_default \
     curlimages/curl:latest -s http://rpc-proxy:4001/metrics \
     | grep "erpc_consensus_total" | grep "outcome=\"success\""
   ```

4. Open a follow-up PR with the change + a one-line entry in the reliability map header.

## Critical incident: 2-of-3 upstreams down

If two upstreams are down simultaneously, every consensus call fails. Driver/orderbook/autopilot stall on every block-tip read. Settlements cannot broadcast.

**Options (in order of preference):**

1. **Wait** — if one of the two failing upstreams is rate-limited and the other is transiently slow, recovery within 5-10 min is normal. The Prom alert fires at 5 min for a reason: that's the worst-case auto-recovery window.

2. **Add a 4th upstream** — emergency single-upstream addition from the pre-vetted candidates above. This is technically a config change but doesn't weaken the consensus invariant (still 2-of-N agreement, just N=4). Same swap procedure as above.

3. **Lower `agreementThreshold` to 1** — **EMERGENCY ONLY, NOT AUDIT-COMPLIANT.** Disables fork-view-poisoning resistance. Use only if (1) the chain is genuinely down for a long stretch AND (2) the alternative is multi-hour zero-settlement window. Edit `erpc.yaml.tmpl` line:
   ```yaml
   agreementThreshold: 1   # EMERGENCY — revert as soon as ≥2 upstreams healthy
   ```
   Re-render + restart. Set a calendar reminder to revert within 1 hour. Open an incident-postmortem PR.

## Caller guidance — prefer explicit block numbers over `latest`

(Codex Cyber post-merge recommendation, PR #71)

The strict-consensus failsafe + naturally-drifting HL upstreams means **`"latest"`-tag queries dispute frequently** (different upstreams resolve "latest" to different blocks at any given moment). For numbered block queries, all upstreams return identical data — no disputes (verified empirically 2026-05-18 across all 3 upstreams, both 1000-back and 10-back blocks).

**When writing new code paths in autopilot / driver / orderbook:**

- ❌ Avoid `eth_getBlockByNumber("latest", ...)` if you can resolve a specific block number first
- ✅ Prefer the pattern: cache the head block number from a single source (e.g., `eth.current_block().borrow().number`), then issue subsequent reads against that specific block number
- ✅ For `eth_call`, default to passing the current block number explicitly rather than letting it default to "latest"

The existing `block_stream` + `current_block()` plumbing in the autopilot already gives you a single-source-of-truth tip; reuse it instead of re-resolving `latest` at every call site.

This is a coding-convention recommendation, not a hard rule. The system tolerates `latest` queries (they just contribute to log noise). Apply judgment.

## Related references

- `infra/hyperevm-mainnet/configs/erpc.yaml.tmpl` — config + reliability map header
- `infra/hyperevm-mainnet/observability/alerts.yml` — `ophis-hl-erpc-consensus` group, full alert annotations
- `docs/audits/2026-05-17-phase1-hyperevm-contracts.md` — Phase 1 audit findings
- `docs/audits/2026-05-18-session-handoff.md` — 2026-05-18 session deltas
- `project_ophis_roadmap.md` (in operator's local memory) — section 3 covers HL eRPC hardening continuation
