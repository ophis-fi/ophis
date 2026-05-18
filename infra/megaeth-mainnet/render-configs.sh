#!/usr/bin/env bash
# Ophis MegaETH mainnet — render *.toml.tmpl into rendered/*.toml.
#
# The CoW solver TOML parser doesn't substitute env vars at parse time, so
# we pre-render TOML templates that need secrets (driver-submitter PK).
#
# Tier 1 PK isolation (2026-05-18): driver.toml is rendered into
# /Users/ophis-driver/rendered/megaeth-mainnet/ owned by ophis-driver (0700
# parent + 0600 file). Other TOMLs render to ./rendered/. PK source is
# /Users/ophis-driver/.config/submitter.key, NOT .env. Sudo required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $SCRIPT_DIR — copy from .env.example first" >&2
  exit 1
fi

# Tier 1: refuse to render if .env still has the PK line.
if grep -qE "^[[:space:]]*OPHIS_DRIVER_SUBMITTER_KEY=" .env; then
  echo "ERROR: .env still contains OPHIS_DRIVER_SUBMITTER_KEY — delete that line." >&2
  echo "       Tier 1 moved the PK source to /Users/ophis-driver/.config/submitter.key." >&2
  exit 4
fi

# Load .env into this shell so envsubst sees the non-PK vars.
set -a
# shellcheck disable=SC1091
source .env
set +a

# Tier 1: read PK from ophis-driver-owned file via sudo.
OPHIS_DRIVER_SUBMITTER_KEY=$(sudo cat /Users/ophis-driver/.config/submitter.key 2>/dev/null | tr -d '\n\r')
if [[ ! "$OPHIS_DRIVER_SUBMITTER_KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: PK from /Users/ophis-driver/.config/submitter.key not a 32-byte hex." >&2
  echo "       Run ./infra/tier1-pk-isolation-setup.sh first." >&2
  exit 5
fi
export OPHIS_DRIVER_SUBMITTER_KEY

OPHIS_RENDERED_DIR="/Users/ophis-driver/rendered/megaeth-mainnet"
if ! sudo test -d "$OPHIS_RENDERED_DIR"; then
  echo "ERROR: $OPHIS_RENDERED_DIR missing. Run ./infra/tier1-pk-isolation-setup.sh." >&2
  exit 6
fi

mkdir -p rendered
shopt -s nullglob

for tmpl in configs/*.toml.tmpl; do
  name="$(basename "$tmpl" .tmpl)"

  if [[ "$name" == "driver.toml" ]]; then
    TMP=$(mktemp); chmod 600 "$TMP"
    envsubst '${OPHIS_DRIVER_SUBMITTER_KEY}' < "$tmpl" > "$TMP"
    sudo install -m 600 -o ophis-driver -g staff "$TMP" "$OPHIS_RENDERED_DIR/driver.toml"
    rm -f "$TMP"
    echo "  rendered  $name → $OPHIS_RENDERED_DIR/driver.toml (owner ophis-driver)"
  else
    out="rendered/$name"
    envsubst '${MEGAETH_MAINNET_RPC}' < "$tmpl" > "$out"
    chmod 600 "$out"
    echo "  rendered  $name"
  fi
done

# Same lock for .env — render-configs.sh runs at every deploy so this
# enforces idempotently.
[ -f .env ] && chmod 600 .env

echo ""
echo "OK. Rendered configs are in $SCRIPT_DIR/rendered/ — gitignored, mode 600."
echo "Bring up the stack with:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
