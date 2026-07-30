# Optimism toxic-pool monitoring pilot

The `Optimism toxic-pool monitor` workflow runs the external
[`wavey0x/toxic-pool-utils`](https://github.com/wavey0x/toxic-pool-utils)
scanner against a read-only Optimism RPC. It is monitoring-only: its output does
not currently block quotes, solutions, or settlements.

## Security and licensing boundary

The scanner is checked out into `.external/` at revision
`f188c245cbb05fd6d629d960f3f4c3cbfa6b83f5`. It is installed without copying or
modifying its source in Ophis. Its complete Python dependency graph is version-
and hash-locked in `tools/toxic-pool-risk/requirements-scanner.lock` (generated
from `requirements-scanner.txt`). Do not vendor, modify, or distribute upstream
source until Ophis has explicit license terms.

Treat all scanner output as untrusted. The Ophis-owned normalizer enforces chain
ID 10, address syntax, row uniqueness, accepted severities, count consistency,
and a six-hour maximum head age. A row with decode or scanner errors becomes
`scan_error`/`unknown`; it can never silently become `clear`.

## Schedule and secrets

- Every three hours: seven-day incremental discovery scan.
- Daily at 02:41 UTC: full 183-day scan with current-factory reconciliation.
- Manual: choose a 1-, 7-, or 183-day window and optionally reconcile.

Configure these Actions secrets:

- `OPHIS_OPTIMISM_READ_RPC_URL` (required): a read-only chain-10 RPC endpoint.
- `OPHIS_TELEGRAM_BOT_TOKEN` (optional): operations-alert bot token.
- `OPHIS_TELEGRAM_CHAT_ID` (optional): operations-alert chat.

The workflow fails if the RPC is absent, reports another chain, becomes stale,
or produces malformed output. GitHub Actions failure notifications remain the
fallback when Telegram is not configured or delivery fails.

## Artifact contract

Each successful run uploads:

- `raw/optimism-scanner.json`: full upstream evidence for incident response.
- `published/optimism.json`: normalized Ophis schema-v1 snapshot.

The normalized snapshot has a canonical `contentHash`, per-row evidence hashes,
an expiry, scanner revision, and explicit `complete` or `scan_error` status.
GitHub retains the workflow artifact for 90 days. The content hash detects
corruption but is not an identity signature; consumers must retrieve artifacts
from the trusted Ophis Actions run until a signing key and publication channel
are introduced.

## Operator response

For workflow failure, first determine whether the RPC, upstream checkout,
dependency install, scan, or normalization failed. Do not replace a failed scan
with an empty snapshot. Consumers should continue using their unexpired
last-known-good snapshot.

For `critical` or `high`, preserve the raw artifact and inspect the affected
pool, provider/proxy bytecode, and behavior probes. During this pilot, notify
solver operators but do not add an automatic global block. A later enforcement
phase must prove the actual pool address from route metadata or calldata and
must add independent solver and driver checks together.

For `scan_error`, treat the affected pool as unknown. Investigate unsupported
factory rows, rate-surface decoding, and RPC completeness before assigning any
clear status.

## Local validation

Run the Ophis-owned adapter tests without installing upstream dependencies:

```sh
cd tools/toxic-pool-risk
python3 -m unittest -v
```
