#!/usr/bin/env bash
# Ophis HyperEVM mainnet — render *.toml.tmpl into rendered/*.toml.
#
# The CoW solver TOML parser doesn't substitute env vars at parse time, so
# we pre-render TOML templates that need secrets (OKX, future KyberSwap).
# Rendered TOMLs go to ./rendered/ which is gitignored.
#
# Reads secrets from ./.env (also gitignored). Run before `docker compose up`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $SCRIPT_DIR — copy from .env.example first" >&2
  exit 1
fi

# Load .env into this shell so envsubst sees the vars
set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p rendered
shopt -s nullglob

for tmpl in configs/*.toml.tmpl configs/*.yaml.tmpl; do
  name="$(basename "$tmpl" .tmpl)"
  out="rendered/$name"
  # envsubst only substitutes the explicit list we pass (prevents accidental
  # substitution of values that happen to contain `$` chars like passphrases).
  envsubst '${ALCHEMY_API_KEY} ${HYPEREVM_MAINNET_RPC} ${HYPEREVM_RPC_INTERNAL} ${OPHIS_DRIVER_SUBMITTER_KEY}' \
    < "$tmpl" > "$out"
  # Rendered files contain plaintext secrets (driver-submitter PK, OKX API
  # keys). Lock to owner-only so anything reading our /Users/scep/greg
  # tree at file-permission granularity is blocked. .env is also chmod 600
  # — see the audit log of 2026-05-14 for the rationale.
  chmod 600 "$out"
  echo "  rendered  $name"
done

# Same lock for .env — render-configs.sh runs at every deploy so this
# enforces idempotently.
[ -f .env ] && chmod 600 .env

echo ""
echo "OK. Rendered configs are in $SCRIPT_DIR/rendered/ — gitignored, mode 600."
echo "Bring up the stack with:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
