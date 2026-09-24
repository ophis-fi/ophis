#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
OUT="$ROOT/infra/arc-mainnet/local/generated"
mkdir -p "$OUT"
# Source build only. This command has no RPC endpoint or transaction signer.
docker run --rm --platform linux/amd64 -v "$ROOT:/repo:ro" -w /repo \
  ethereum/solc:0.8.30@sha256:b116bf835554d40c501feab0b2c943a8c5eec003b804bcc5b326b85c93da00c2 \
  --base-path . --optimize --optimize-runs 1000000 --evm-version shanghai --combined-json abi,bin,bin-runtime \
  contracts/src/contracts/GPv2Settlement.sol contracts/src/contracts/GPv2AllowListAuthentication.sol \
  infra/arc-mainnet/local/Fixtures.sol infra/arc-mainnet/local/ReadOnlyV3Probe.sol > "$OUT/contracts.json"
