# Optimism eRPC consensus — operational runbook

Updated 2026-09-16 for backend-only Goldsky Boost. The website retains its
public RPC. See [Boost routing](goldsky-boost.md) for compatibility limits.

## Current routing

The backend reads through `rpc-proxy:4000/main/evm/10` (host loopback port
4001). Four configured providers supply exactly three eligible voters per
protected method:

| Protected methods | Eligible voters |
| --- | --- |
| State/simulation: call, balance, code, storage, estimateGas, feeHistory, transactionCount | `goldsky-op` (Boost/Alchemy), `zan-op`, `tenderly-op` |
| TransactionByHash, transactionReceipt, getLogs | `drpc-op`, `zan-op`, `tenderly-op` |

Every protected group retains `maxParticipants: 3`, `agreementThreshold: 2`
and `lowParticipantsBehavior: returnError`. Existing dispute policies remain
pinned by `assert-erpc-failclosed.py`. Application block-number and
block-by-number reads exclude dRPC; dRPC's private state poller still uses
those methods to stay eligible for transaction/receipt/log consensus.

Boost's cached full objects differ from the other providers. Do not route
transactions, receipts or logs through Boost, ignore response fields, or
lower quorum to hide these differences. Do not point Boost at another voter
or back at Ophis eRPC. Both would undermine provider independence.

The active configuration and method filters in
`infra/optimism-mainnet/configs/erpc.yaml.tmpl` are authoritative. Its older
dated incident notes describe previous topologies, not current voters.

## Diagnose a failure

1. Identify the failing request category in consensus metrics/logs, then
   select its three voters from the table. Inspect upstream-labelled errors
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
reviewed host set and method filters. There is no permanently pre-vetted
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

The driver broadcasts through five `[[submission.mempool]]` relays:
PublicNode, the official OP gateway, Tenderly, Goldsky Boost and dRPC.
Keep both Goldsky and dRPC to preserve overlap with pending-nonce readers.
Changes to submission relays require rendering and recreating the driver.

Broadcast acknowledgements do not prove inclusion. Receipt verification
continues through the original dRPC/ZAN/Tenderly consensus route. A submission
provider can observe signed calldata; multiple relays do not eliminate that
exposure.
