# Optimism eRPC consensus — operational runbook

**Audience:** Ophis on-call operator responding to an OP stack RPC issue.
**Last updated:** 2026-05-19 (PR #130 — OP eRPC proxy clone).

## System model in 60 seconds

The OP stack reads chain state via an **eRPC proxy** (`rpc-proxy`
container) that fans every consensus-protected request out to **3
upstreams**:

| Upstream | Endpoint | Failure domain | Notes |
|---|---|---|---|
| `official-op` | `https://mainnet.optimism.io` | Conduit / AWS (CF-fronted) | OP Foundation; DNS: Cloudflare; CA: CF/Google |
| `publicnode-op` | `https://optimism-rpc.publicnode.com` | Allnodes multi-cloud | Prior sole provider; DNS: Route53; CA: Let's Encrypt |
| `ankr-op` | `https://rpc.ankr.com/optimism` | Ankr public | DNS: Ankr-operated (NOT Cloudflare); CA: ZeroSSL/Sectigo |

`llamarpc-op` was the initial 3rd pick — replaced by ankr-op
(pre-merge adversarial review, PR #130) because llamarpc shared
Cloudflare DNS with official-op (a single CF control-plane compromise
would hijack 2-of-3 simultaneously, meeting the consensus threshold
and forging reads). Failure-domain rationale lives in
`infra/optimism-mainnet/configs/erpc.yaml.tmpl` header.

**Consensus policy:** `maxParticipants=2`, `agreementThreshold=2`,
`disputeBehavior=returnError`, `lowParticipantsBehavior=returnError`.
Audit-required to defeat fork-view-poisoning (any 1 hostile upstream
cannot influence outcomes).

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

**No OP-specific Prometheus alerts deployed yet** (as of 2026-05-19).
The HL stack has `ophis-hl-erpc-consensus` (PR #76); the OP equivalent
is on the long-tail roadmap as `ophis-op-erpc-consensus`. Until
deployed, diagnose interactively from eRPC's `/metrics` endpoint
(see Step 2 below).

When the OP alert PR ships, the alert names will mirror HL with the
`Op` infix:

| Alert | Equivalent in HL | Severity |
|---|---|---|
| `OphisOpErpcConsensusLowParticipantsHigh` | `OphisHlErpc…` | warning |
| `OphisOpErpcConsensusDisputeHigh` | same | warning |
| `OphisOpErpcConsensusFailureCritical` | same | **critical** |

All three would monitor `erpc_consensus_errors_total{network="evm:10"}`.

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

**Pre-vetted candidates** (probed conceptually 2026-05-19; re-probe
before live use):

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
   cd /Users/scep/greg/infra/optimism-mainnet
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

## Submission path (NOT consensus-protected)

The driver submits transactions via `[[submission.mempool]]` in
`driver.toml.tmpl` which points at `https://optimism-rpc.publicnode.com`
**directly**, bypassing eRPC. This is intentional: tx submission needs
a single nonce-coherent endpoint, not a load-balanced fan-out.

If publicnode.com goes down as a *submission* endpoint, the driver
stops broadcasting (but pending settlements aren't lost — they
re-broadcast on next driver bootstrap with corrected mempool URL).
Edit `[[submission.mempool]] url = …` in `driver.toml.tmpl`, re-render,
restart driver.

**Receipt-poisoning protection:** receipts read via `eth_getTransactionReceipt`
go through the eRPC consensus path (verified at config — receipt
method is included in the consensus matchMethod regex). So a hostile
submission RPC lying about inclusion is caught: autopilot sees the
tx never landed via consensus-protected reads, retries.

**MEV leakage residual:** a hostile submission RPC can leak signed
calldata to a private searcher before propagation. Bounded but real;
roadmap item to add a 2nd submission mempool (Conduit sequencer-direct
or OP private mempool) for race-based submission.

## Related references

- `infra/optimism-mainnet/configs/erpc.yaml.tmpl` — config + failure-domain map
- `docs/operations/hl-erpc-runbook.md` — sibling HL runbook (consult for shared patterns)
- `docs/operations/distributed-tracing.md` — Jaeger collector setup (PR #134)
- `docs/architecture/2026-05-18-submitter-pk-custody-adr.md` — driver-submitter PK custody (Tier 1/1.5/2)
