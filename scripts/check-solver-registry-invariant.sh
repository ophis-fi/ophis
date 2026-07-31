#!/usr/bin/env bash
# Verifies that the frontend static solver registry mirrors the chain-10 driver
# config exactly:
#   - infra/optimism-mainnet/configs/autopilot.toml   ([[drivers]] name entries)
#   - apps/frontend/apps/cowswap-frontend/src/ophis/solvers.ts (solverId entries)
#
# WHY THE AUTOPILOT, NOT THE DRIVER CONFIG (changed 2026-07-30):
# this gate used to pin the registry against driver.toml.tmpl's [[solver]] list,
# which is the set of lanes that EXIST. The number the registry feeds to users is
# "up to N solvers can compete", and a lane only competes if the AUTOPILOT sends
# it an auction. On 2026-07-30 driver.toml.tmpl listed 9 lanes on chain 10 while
# autopilot.toml declared 4 [[drivers]], so the shipped row overstated by 5:
# odos, enso, openocean and dodo could never receive an auction at all. Pinning
# the wrong file made that drift invisible to CI.
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

# Every chain the registry declares must be pinned. A chain listed in solvers.ts
# but absent here can drift silently: that is exactly how chain 10 came to claim
# 9 competing solvers when its autopilot dispatched 4.
#   <registry chain-id constant>|<autopilot config>
CHAIN_PINS=(
  "OPHIS_SOLVER_REGISTRY_CHAIN_ID|infra/optimism-mainnet/configs/autopilot.toml"
  "OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID|infra/unichain-mainnet/configs/autopilot.toml.tmpl"
  "OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID|infra/robinhood-mainnet/configs/autopilot.toml.tmpl"
)
REGISTRY=apps/frontend/apps/cowswap-frontend/src/ophis/solvers.ts

# Interpreter override for dev machines whose PATH python3 is a policy shim
# (e.g. CHECK_SOLVER_PYTHON=/usr/bin/python3). CI uses the default.
PYTHON_BIN=${CHECK_SOLVER_PYTHON:-python3}

for f in "$REGISTRY"; do
  [[ -f "$f" ]] || { echo "ERROR: $f missing" >&2; exit 1; }
done

extract_autopilot() {
  ${PYTHON_BIN} - "$1" <<'PY'
import re, sys, json
with open(sys.argv[1]) as f:
    src = f.read()
# Strip TOML comments so prose never contributes a name.
src = re.sub(r'#[^\n]*', '', src)
names = re.findall(r'\[\[drivers\]\]\s*\n\s*name\s*=\s*"([^"]+)"', src)
if not names:
    print('NO_AUTOPILOT_DRIVERS_FOUND', file=sys.stderr); sys.exit(3)
if len(set(names)) != len(names):
    print('DUPLICATE_AUTOPILOT_DRIVER_NAME', file=sys.stderr); sys.exit(3)
print(json.dumps(sorted(names), separators=(',', ':')))
PY
}

extract_registry() {
  ${PYTHON_BIN} - "$1" "$2" <<'PY'
import re, sys, json
with open(sys.argv[1]) as f:
    src = f.read()
# Strip comments so prose never contributes a name.
src = re.sub(r'/\*[\s\S]*?\*/', '', src)
src = re.sub(r'//[^\n]*', '', src)
m = re.search(r'OPHIS_SOLVERS\s*:[^=]*=\s*(\[[\s\S]*?\])\s*\n', src)
if not m:
    print('NO_REGISTRY_FOUND', file=sys.stderr); sys.exit(3)
entries = re.findall(
    r"\{[^{}]*solverId\s*:\s*'([^']+)'[^{}]*chainIds\s*:\s*\[([^\]]*)\][^{}]*\}",
    m.group(1),
)
chain_const = sys.argv[2]
names = [
    solver_id
    for solver_id, chain_ids in entries
    if chain_const in chain_ids
]
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

  printf '%s\n\n[[drivers]]\nname = "selftest-drift"\nurl = "http://x"\n' "$(cat "$AUTOPILOT")" > "$tmpdir/drift.toml"
  local base drift
  base=$(extract_autopilot "$AUTOPILOT")
  drift=$(extract_autopilot "$tmpdir/drift.toml")
  if [[ "$base" == "$drift" ]]; then
    echo "FATAL: self-test failed, the autopilot extractor missed an appended [[drivers]] entry" >&2
    exit 4
  fi
}

AUTOPILOT="${CHAIN_PINS[0]#*|}"
self_test

drifted=0
for pin in "${CHAIN_PINS[@]}"; do
  chain_const="${pin%%|*}"
  autopilot_file="${pin#*|}"

  if [[ ! -f "$autopilot_file" ]]; then
    echo "ERROR: $autopilot_file missing (pinned for $chain_const)" >&2
    exit 1
  fi

  autopilot_set=$(extract_autopilot "$autopilot_file")
  registry_set=$(extract_registry "$REGISTRY" "$chain_const")

  if [[ "$autopilot_set" == "$registry_set" ]]; then
    echo "OK: $chain_const mirrors $autopilot_file"
    echo "  $autopilot_set"
    continue
  fi

  drifted=1
  echo "FATAL: solver registry drift on $chain_const" >&2
  echo "  autopilot $autopilot_file: $autopilot_set" >&2
  echo "  registry  $REGISTRY:       $registry_set" >&2
done

if [[ "$drifted" == "0" ]]; then
  echo "OK: solver registry mirrors every pinned autopilot (extractor self-test passed)"
  exit 0
fi

echo "  The registry feeds the user-facing 'up to N solvers' count on chain 10." >&2
echo "  A lane only competes if the AUTOPILOT dispatches an auction to it, so a lane" >&2
echo "  present in driver.toml.tmpl but absent from autopilot.toml must NOT be in the" >&2
echo "  registry. Reconcile both files in the same PR (registry solverId must equal the" >&2
echo "  autopilot driver name, lowercase)." >&2
exit 2
