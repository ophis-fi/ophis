#!/usr/bin/env bash
# Ophis — cross-stack eRPC upstream-ID collision lint.
#
# Phase 2.6 (2026-05-20). Roadmap #6. eRPC exports per-upstream
# Prometheus metrics labeled by `id:`. If stacks share an
# upstream ID, the same metric label gets two different sources and
# dashboards mis-attribute load.
#
# This script asserts:
#   1. Every upstream id has a chain suffix
#   2. No id appears in more than one chain's eRPC config
#
# POSIX-friendly (no associative arrays — macOS bash 3.2 compat).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Chain dirs + accepted chain-specific ID tags (parallel arrays). Existing
# metric IDs use both abbreviated suffixes and descriptive prefixes.
CHAIN_DIRS=("optimism-mainnet" "unichain-mainnet" "robinhood-mainnet")
CHAIN_TAGS=("-op"               "-uni unichain-"     "-rbh robinhood-")

errors=0
ALL_IDS_FILE=$(mktemp)
trap 'rm -f "$ALL_IDS_FILE"' EXIT

for i in "${!CHAIN_DIRS[@]}"; do
  chain_dir="${CHAIN_DIRS[$i]}"
  expected_tags="${CHAIN_TAGS[$i]}"
  cfg="infra/${chain_dir}/configs/erpc.yaml.tmpl"
  [[ -f "$cfg" ]] || continue  # paused chain — skip

  while IFS= read -r id; do
    [[ -z "$id" ]] && continue

    # Check that the metric ID carries one of this chain's established tags.
    tag_match=0
    for tag in $expected_tags; do
      case "$id" in *"$tag"*) tag_match=1 ;; esac
    done
    if (( tag_match == 0 )); then
      echo "FAIL: $cfg upstream '$id' lacks a chain tag (${expected_tags})" >&2
      errors=$((errors + 1))
    fi

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
  echo "  1. Include one of the chain's configured ID tags" >&2
  echo "  2. NOT appear in any other chain's eRPC config" >&2
  exit 1
fi

echo "OK: eRPC upstream IDs across all chains:"
sort -t'|' -k2 -k1 "$ALL_IDS_FILE" | while IFS='|' read -r id chain; do
  printf "  %-25s → %s\n" "$id" "$chain"
done
echo "No collisions, all IDs chain-suffixed."
exit 0
