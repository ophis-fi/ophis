#!/usr/bin/env bash
# Verifies that the frontend static solver registry mirrors the chain-10 driver
# config exactly:
#   - infra/optimism-mainnet/configs/driver.toml.tmpl   ([[solver]] name entries)
#   - apps/frontend/apps/cowswap-frontend/src/ophis/solvers.ts (solverId entries)
# Hard CI gate (ux-quoting, 2026-07). The registry feeds the "up to N solvers"
# row and the order progress bar ladder on the sovereign chain; drift would
# show users a wrong solver count or a ladder missing live solvers. Comments
# are stripped on both sides so prose never affects the comparison; the
# comparison is on the SORTED NAME SET, so ordering and formatting are free.
#
# A built-in self-test proves on every run that the extractors reject a
# mutated copy (an added driver solver must fail the gate), so a regression in
# the extraction regexes cannot silently disarm the gate.

set -euo pipefail

DRIVER=infra/optimism-mainnet/configs/driver.toml.tmpl
REGISTRY=apps/frontend/apps/cowswap-frontend/src/ophis/solvers.ts

# Interpreter override for dev machines whose PATH python3 is a policy shim
# (e.g. CHECK_SOLVER_PYTHON=/usr/bin/python3). CI uses the default.
PYTHON_BIN=${CHECK_SOLVER_PYTHON:-python3}

for f in "$DRIVER" "$REGISTRY"; do
  [[ -f "$f" ]] || { echo "ERROR: $f missing" >&2; exit 1; }
done

extract_driver() {
  ${PYTHON_BIN} - "$1" <<'PY'
import re, sys, json
with open(sys.argv[1]) as f:
    src = f.read()
# Strip TOML comments so prose never contributes a name.
src = re.sub(r'#[^\n]*', '', src)
names = re.findall(r'\[\[solver\]\]\s*\n\s*name\s*=\s*"([^"]+)"', src)
if not names:
    print('NO_DRIVER_SOLVERS_FOUND', file=sys.stderr); sys.exit(3)
if len(set(names)) != len(names):
    print('DUPLICATE_DRIVER_SOLVER_NAME', file=sys.stderr); sys.exit(3)
print(json.dumps(sorted(names), separators=(',', ':')))
PY
}

extract_registry() {
  ${PYTHON_BIN} - "$1" <<'PY'
import re, sys, json
with open(sys.argv[1]) as f:
    src = f.read()
# Strip comments so prose never contributes a name.
src = re.sub(r'/\*[\s\S]*?\*/', '', src)
src = re.sub(r'//[^\n]*', '', src)
m = re.search(r'OPHIS_SOLVERS\s*:[^=]*=\s*(\[[\s\S]*?\])\s*\n', src)
if not m:
    print('NO_REGISTRY_FOUND', file=sys.stderr); sys.exit(3)
names = re.findall(r"solverId\s*:\s*'([^']+)'", m.group(1))
if not names:
    print('NO_REGISTRY_SOLVERS_FOUND', file=sys.stderr); sys.exit(3)
if len(set(names)) != len(names):
    print('DUPLICATE_REGISTRY_SOLVER_ID', file=sys.stderr); sys.exit(3)
print(json.dumps(sorted(names), separators=(',', ':')))
PY
}

# --- Self-test: a driver-side addition MUST change the extracted set. --------
self_test() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' RETURN

  printf '%s\n\n[[solver]]\nname = "selftest-drift"\nendpoint = "http://x"\n' "$(cat "$DRIVER")" > "$tmpdir/drift.toml"
  local base drift
  base=$(extract_driver "$DRIVER")
  drift=$(extract_driver "$tmpdir/drift.toml")
  if [[ "$base" == "$drift" ]]; then
    echo "FATAL: self-test failed, the driver extractor missed an appended [[solver]] entry" >&2
    exit 4
  fi
}

self_test

DRIVER_SET=$(extract_driver "$DRIVER")
REGISTRY_SET=$(extract_registry "$REGISTRY")

if [[ "$DRIVER_SET" == "$REGISTRY_SET" ]]; then
  echo "OK: solver registry mirrors ${DRIVER} (extractor self-test passed)"
  echo "  $DRIVER_SET"
  exit 0
fi

echo "FATAL: solver registry drift" >&2
echo "  driver   $DRIVER: $DRIVER_SET" >&2
echo "  registry $REGISTRY: $REGISTRY_SET" >&2
echo "  The registry feeds the 'up to N solvers' row and the progress-bar ladder on chain 10." >&2
echo "  Reconcile both files in the same PR (registry solverId must equal the driver name, lowercase)." >&2
exit 2
