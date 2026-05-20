#!/usr/bin/env bash
# Ophis — cross-stack eRPC upstream-ID collision lint.
#
# Phase 2.6 (2026-05-20). Roadmap #6. eRPC exports per-upstream
# Prometheus metrics labeled by `id:`. If HL and OP stacks share an
# upstream ID, the same metric label gets two different sources and
# dashboards mis-attribute load.
#
# This script asserts:
#   1. Every upstream id has a chain-suffix (-hl, -op, -mega)
#   2. No id appears in more than one chain's eRPC config
#
# POSIX-friendly (no associative arrays — macOS bash 3.2 compat).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Chain dirs + expected suffixes (parallel arrays).
CHAIN_DIRS=("hyperevm-mainnet"  "optimism-mainnet"  "megaeth-mainnet")
CHAIN_SUFFIXES=("hl"             "op"                "mega")

errors=0
ALL_IDS_FILE=$(mktemp)
trap 'rm -f "$ALL_IDS_FILE"' EXIT

for i in "${!CHAIN_DIRS[@]}"; do
  chain_dir="${CHAIN_DIRS[$i]}"
  expected_suffix="${CHAIN_SUFFIXES[$i]}"
  cfg="infra/${chain_dir}/configs/erpc.yaml.tmpl"
  [[ -f "$cfg" ]] || continue  # paused chain — skip

  while IFS= read -r id; do
    [[ -z "$id" ]] && continue

    # Check suffix
    case "$id" in
      *"-${expected_suffix}") ;;  # OK
      *)
        echo "FAIL: $cfg upstream '$id' lacks chain suffix '-${expected_suffix}'" >&2
        errors=$((errors + 1))
        ;;
    esac

    # Check collision (look up in flat ALL_IDS_FILE)
    if grep -Fxq "${id}|" "$ALL_IDS_FILE" 2>/dev/null; then
      other=$(grep -F "${id}|" "$ALL_IDS_FILE" | cut -d'|' -f2)
      echo "FAIL: id '$id' declared in both ${other} and ${chain_dir}" >&2
      echo "       (causes Prometheus metric-label collision)" >&2
      errors=$((errors + 1))
    fi
    echo "${id}|${chain_dir}" >> "$ALL_IDS_FILE"
  done < <(awk '/^      - id:/ {print $3}' "$cfg")
done

if (( errors > 0 )); then
  echo "" >&2
  echo "eRPC ID lint FAILED ($errors issues)." >&2
  echo "" >&2
  echo "Every upstream 'id:' field must:" >&2
  echo "  1. End with the chain's suffix (-hl / -op / -mega)" >&2
  echo "  2. NOT appear in any other chain's eRPC config" >&2
  exit 1
fi

echo "OK: eRPC upstream IDs across all chains:"
sort -t'|' -k2 -k1 "$ALL_IDS_FILE" | while IFS='|' read -r id chain; do
  printf "  %-25s → %s\n" "$id" "$chain"
done
echo "No collisions, all IDs chain-suffixed."
exit 0
