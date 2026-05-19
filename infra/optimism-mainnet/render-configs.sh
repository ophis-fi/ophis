#!/usr/bin/env bash
# Ophis OP mainnet — render *.toml.tmpl into ./rendered/*.toml.
#
# The CoW solver TOML parser doesn't substitute env vars at parse time, so
# we pre-render TOML templates that need secrets (OKX, driver-submitter PK).
#
# ## Tier 1 PK isolation (2026-05-18, scope-honest 2026-05-19)
#
# **What Tier 1 actually achieves today:**
#   - PK source-of-truth is the file at /Users/ophis-driver/.config/submitter.key
#     (mode 0600, owner ophis-driver), NOT a .env entry that other processes
#     running as scep could read.
#   - The script refuses to run if .env still contains the legacy
#     OPHIS_DRIVER_SUBMITTER_KEY line.
#   - Read requires sudo, which is YubiKey-gated when MFA is configured.
#
# **What Tier 1 DOES NOT achieve (Phase 4 audit H1, 2026-05-19):**
#   - The rendered driver.toml STILL lives at ./rendered/driver.toml under
#     scep's home directory (mode 0600 owner=scep). Any process running as
#     scep can read it. This is NOT "isolation from scep"; it's "isolation
#     from random other-user processes" (of which the Mac mini has none in
#     practice).
#
# **Why we can't fix this in Tier 1:**
#   - colima's virtiofs daemon runs as scep and can ONLY bind-mount paths
#     scep can read. Moving the rendered driver.toml to
#     /Users/ophis-driver/rendered/... would break the docker bind mount
#     (verified: docker-compose.yml driver volume mount is
#     ./rendered/driver.toml:/driver.toml:ro).
#
# **Upgrade paths from here:**
#   1. Tier 1.5 (in-RAM): render driver.toml to a hdiutil-managed RAM disk
#      that's bind-mounted into the container. Avoids on-disk PK exposure.
#      ~Half-day of work; tracked as a follow-up.
#   2. Tier 2 (KMS, $140/yr AWS): the driver's Account::Kms code path
#      already exists. Eliminates local PK exposure entirely. Tracked as
#      roadmap task 1.9.
#   3. Switch off colima (Rancher Desktop / Docker Desktop) to enable
#      cross-user bind mounts. ~1-2h migration; risks breaking other dev
#      workflows.
#
# Run before `docker compose up`. Run from this directory.
#
# ## Caveats not enforced by this script
#
#   - If `/etc/sudoers` has `Defaults log_input`, the PK is written to
#     `/var/log/sudo-io/` when sudo prompts on TTY. Check + remove that
#     directive before relying on Tier 1 (sharp-edges note).
#   - Tier 1 protects against random scep-process exfiltration. Same-UID
#     processes (e.g. shared systemd User= accounts) bypass it; the Mac
#     mini doesn't have any such today.
#
# ## Exit codes
#   1 — .env missing
#   2 — running under set -x (PK would leak in trace)
#   4 — .env still has legacy OPHIS_DRIVER_SUBMITTER_KEY line
#   5 — PK file at /Users/ophis-driver/.config/submitter.key is malformed

set -euo pipefail
# Defense-in-depth (Phase 4 audit H2): tighten umask BEFORE any file
# operations so the brief window between `envsubst > out` and `chmod 600`
# can't be opened by another process. Without this, the default macOS
# umask (022) leaves a microsecond-scale 0644 window per template.
umask 077

# Refuse to run under `set -x` / `bash -x` (sharp-edges audit pattern,
# mirroring HL render-configs.sh:18-25): the sudo cat below traces the
# PK if -x is set.
if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: the PK would leak in the trace." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $SCRIPT_DIR — copy from .env.example first" >&2
  exit 1
fi

# Tier 1 PK isolation: refuse to render if .env still has the PK line.
# (Env-var precedence from `source .env` would mask the ophis-driver file.)
if grep -qE "^[[:space:]]*OPHIS_DRIVER_SUBMITTER_KEY=" .env; then
  echo "ERROR: .env still contains OPHIS_DRIVER_SUBMITTER_KEY — delete that line." >&2
  echo "       Tier 1 moved the PK source to /Users/ophis-driver/.config/submitter.key." >&2
  exit 4
fi

# Tighten .env perms BEFORE reading it (sharp-edges MED-3, pre-PR
# review): chmod 600 after `source` would leave the file world-readable
# during the read window. Idempotent — chmod is a no-op if already 600.
chmod 600 .env

# Load .env into this shell so envsubst sees the non-PK vars (OP_MAINNET_RPC,
# OKX_*). After Tier 1, .env has NO PK and source can't re-introduce it.
set -a
# shellcheck disable=SC1091
source .env
set +a

# Read PK from ophis-driver-owned file via sudo (need root to bypass 0700 home).
OPHIS_DRIVER_SUBMITTER_KEY=$(sudo cat /Users/ophis-driver/.config/submitter.key 2>/dev/null | tr -d '\n\r')
if [[ ! "$OPHIS_DRIVER_SUBMITTER_KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: PK from /Users/ophis-driver/.config/submitter.key not a 32-byte hex." >&2
  echo "       Run ./infra/tier1-pk-isolation-setup.sh first." >&2
  exit 5
fi
export OPHIS_DRIVER_SUBMITTER_KEY

mkdir -p rendered
shopt -s nullglob

# sharp-edges H1 (2026-05-19): if OP_RPC_INTERNAL is set, ALL chain-reading
# services bypass the eRPC proxy and route through whatever URL the operator
# pasted. That's a legitimate failure-domain-test knob but it silently
# downgrades the stack to the pre-PR single-provider posture (no consensus,
# no fail-closed read protection). Loud warning so a forgotten override
# can't quietly sit in .env for days.
if [[ -n "${OP_RPC_INTERNAL:-}" ]]; then
  echo "" >&2
  echo "*** WARNING: OP_RPC_INTERNAL is set in .env ***" >&2
  echo "    Value: ${OP_RPC_INTERNAL}" >&2
  echo "    The eRPC proxy + 2-of-3 consensus path is BYPASSED." >&2
  echo "    All chain reads will route through this single URL." >&2
  echo "    Unset OP_RPC_INTERNAL in .env to restore proxy mode." >&2
  echo "" >&2
fi

for tmpl in configs/*.toml.tmpl configs/*.yaml.tmpl; do
  # `shopt -s nullglob` (set above) makes the globs return nothing when
  # there are no matches, so this loop is safe even if only one extension
  # is present.
  name="$(basename "$tmpl" .tmpl)"
  out="rendered/$name"
  # envsubst only substitutes the explicit list we pass — keeps unknown
  # ${VARS} in eRPC's YAML syntax (none today, but defensive against
  # future eRPC config additions like ${ALCHEMY_API_KEY}).
  envsubst '${OP_MAINNET_RPC} ${OKX_PROJECT_ID} ${OKX_API_KEY} ${OKX_SECRET_KEY} ${OKX_PASSPHRASE} ${OPHIS_DRIVER_SUBMITTER_KEY}' \
    < "$tmpl" > "$out"
  # Redundant under `umask 077` set at script top, but kept as defense-
  # in-depth against a future edit that hoists or removes the umask.
  chmod 600 "$out"
  echo "  rendered  $name"
done

echo ""
echo "OK. Rendered configs are in $SCRIPT_DIR/rendered/ — gitignored, mode 600."
echo "Bring up the stack with:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
