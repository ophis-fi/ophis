#!/usr/bin/env bash
# Ophis OP mainnet — render *.toml.tmpl into rendered/*.toml.
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

for tmpl in configs/*.toml.tmpl; do
  name="$(basename "$tmpl" .tmpl)"
  out="rendered/$name"
  # envsubst only substitutes the explicit list we pass (prevents accidental
  # substitution of values that happen to contain `$` chars like passphrases).
  envsubst '${OP_MAINNET_RPC} ${OKX_PROJECT_ID} ${OKX_API_KEY} ${OKX_SECRET_KEY} ${OKX_PASSPHRASE} ${OPHIS_DRIVER_SUBMITTER_KEY}' \
    < "$tmpl" > "$out"
  echo "  rendered  $name"
done

echo ""
echo "OK. Rendered configs are in $SCRIPT_DIR/rendered/ — gitignored."
echo "Bring up the stack with:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
