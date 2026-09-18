# Optimism eRPC consensus — operational runbook

Updated 2026-09-18 after Goldsky Boost forwarded Alchemy's monthly-capacity error.
OP has returned to dRPC, ZAN and Tenderly. The website retains its public RPC.

## Current routing

The backend reads through `rpc-proxy:4000/main/evm/10` (host loopback port
4001). All protected state, simulation, transaction, receipt and log methods
use exactly three eligible voters: `drpc-op`, `zan-op`, and `tenderly-op`.
Every protected group retains `maxParticipants: 3`, `agreementThreshold: 2`
and both dispute/low-participant policies set to `returnError`. The pinned
engine's leader preference can otherwise accept a lone reply before checking
low participation. Consensus wait caps are explicitly 12s, matching the existing
network timeout; adaptive defaults cancelled slower voters after only 5ms.
The guard pins these values. Genuine tip disagreements may now return transient
errors instead of selecting one provider's view.

There are no method filters or application head exclusions. An explicit policy
keeps every uncordoned voter eligible; the implicit legacy policy sidelined a
recovered dRPC lane after its rate-limit burst. Goldsky is absent
from OP reads and submission. Do not restore it while its Alchemy upstream is
quota-exhausted. The three remaining providers are also quota-dependent;
provider health must include actual state, populated receipt and log responses.

The active configuration and guard are authoritative. Older dated incident
notes in the template describe previous topologies, not current voters.

## Diagnose a failure

1. Identify the failing request category in consensus metrics/logs, then
   check all three configured voters. Inspect upstream-labelled errors
   and `erpc_upstream_block_head_lag{network="evm:10"}`. A block-head gap over
   five blocks is suspicious, but a healthy head does not prove logs or
   receipts are available.
2. Probe those providers using the credential-bearing endpoints in the
   private `rendered/erpc.yaml`. Keep URLs out of shared logs and reports.
   Reproduce the affected method at a fixed block, including populated logs
   and a mined receipt. Compare with the production proxy.
3. Distinguish rate limits, authentication failures, timeouts, stale indexing
   and response disagreements. dRPC rate limits were observed before the
   Boost rollout; they can still affect its retained methods.

Prometheus is available on host loopback port 9091. Useful metrics include
`erpc_consensus_errors_total`, `erpc_upstream_request_errors_total` and
`erpc_upstream_block_head_lag`. Alert silence is not proof of health:
low-traffic settlement failures may stay below rate thresholds.

Tip reads can disagree as providers advance at different times. Prefer
explicit block numbers for reproducible diagnostics. Log indexes may lag
heads; test an older block to distinguish temporary indexing delay from a
persistent outage. Receipt/log failures can stall settlement indexing.

## Recover without weakening consensus

Restore the affected provider's credentials, quota or connectivity. If a
replacement is necessary, verify its operator and CDN/DNS independence,
response compatibility, archive support and latency before changing the
reviewed host set and routing. There is no permanently pre-vetted
public fallback list. Keep three eligible voters and two required matching
responses for every protected method.

Do not add an unrestricted fourth voter, lower the agreement threshold, or
set `OP_RPC_INTERNAL` to a single external endpoint. That override bypasses
consensus. Remove any unexpected override before rendering.

Make reviewed changes in the live checkout. Confirm the mount source with
`docker inspect optimism-mainnet-rpc-proxy-1`; the current deployment is
`/Users/scep/greg-wt/op-deploy-0730/infra/optimism-mainnet`.
Run `python3 scripts/test-boost-rpc.py` from the repository root and the
chain's `assert-erpc-failclosed.py` against its template. Preserve unrelated
live changes and keep rendered credentials on RAM-disk.

After rendering, recreate only the affected services:

```bash
docker compose up -d --no-deps --force-recreate rpc-proxy
```

Allow the upstream pollers to warm up. Verify proxy health, driver health,
advancing auction blocks, protected state reads, populated logs and receipts.
Compare failures against the previous configuration. Keep a private rollback
copy of the previous rendered configuration. Reload Prometheus when alert
annotations change; they are mounted directly from `observability/alerts.yml`.

## Submission and receipts

The driver broadcasts through four `[[submission.mempool]]` relays:
PublicNode, the official OP gateway, Tenderly and dRPC.
Keep Tenderly and dRPC to preserve overlap with pending-nonce readers.
Changes to submission relays require rendering and recreating the driver.

Broadcast acknowledgements do not prove inclusion. Receipt verification
continues through the original dRPC/ZAN/Tenderly consensus route. A submission
provider can observe signed calldata; multiple relays do not eliminate that
exposure.
