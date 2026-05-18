#!/usr/bin/env bash
# Ophis HyperEVM mainnet — render *.toml.tmpl into rendered/*.toml.
#
# The CoW solver TOML parser doesn't substitute env vars at parse time, so
# we pre-render TOML templates that need secrets (OKX, future KyberSwap).
# Rendered TOMLs go to ./rendered/ which is gitignored.
#
# Reads secrets from ./.env (also gitignored). Run before `docker compose up`.

set -euo pipefail

# Defense-in-depth (sharp-edges audit, 2026-05-17): rendered files contain
# the driver-submitter private key and the Telegram bot token. With the
# default macOS umask of 022, `envsubst > file` creates 0644 momentarily
# before the explicit `chmod 600` tightens. A process watching the directory
# could open() during that window. `umask 077` ensures every `>` produces
# 0600 from the start; later `chmod 600` calls stay as belt-and-braces.
umask 077

# Sharp-edges audit also flagged: NEVER run this script under `set -x` /
# `bash -x` — the `:?` guards trace variable values, leaking the
# driver-submitter PK + Telegram token into stdout/stderr. Refuse upfront.
if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: secrets would leak in the trace." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $SCRIPT_DIR — copy from .env.example first" >&2
  exit 1
fi

# Tier 1 PK isolation (2026-05-18): refuse if .env still has the PK line.
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

# Tier 1: read PK from ophis-driver-owned file via sudo (need root to bypass
# 0700 home dir). Sourced AFTER `source .env` to avoid accidental override.
OPHIS_DRIVER_SUBMITTER_KEY=$(sudo cat /Users/ophis-driver/.config/submitter.key 2>/dev/null | tr -d '\n\r')
if [[ ! "$OPHIS_DRIVER_SUBMITTER_KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: PK from /Users/ophis-driver/.config/submitter.key not a 32-byte hex." >&2
  echo "       Run ./infra/tier1-pk-isolation-setup.sh first." >&2
  exit 5
fi
export OPHIS_DRIVER_SUBMITTER_KEY

OPHIS_RENDERED_DIR="/Users/ophis-driver/rendered/hyperevm-mainnet"
if ! sudo test -d "$OPHIS_RENDERED_DIR"; then
  echo "ERROR: $OPHIS_RENDERED_DIR missing. Run ./infra/tier1-pk-isolation-setup.sh." >&2
  exit 6
fi

# Fail FAST if any required NON-PK secret is missing — otherwise envsubst
# silently substitutes empty string and the driver/orderbook fails far
# downstream with an opaque error. Each :? guard prints the named var + hint.
: "${ALCHEMY_API_KEY:?must be set in .env — see .env.example}"
: "${HYPEREVM_MAINNET_RPC:?must be set in .env — see .env.example}"
: "${HYPEREVM_RPC_INTERNAL:?must be set in .env — see .env.example}"
: "${TELEGRAM_BOT_TOKEN:?must be set in .env — Alertmanager → Telegram. Lookup via the path in .env.example.}"
# Default to the verified-live Ormi-hosted HyperSwap V3 subgraph (Phase 1
# of the V3 wiring spec). Operator can override to self-hosted Goldsky /
# graph-node in .env when Phase 2/3 work lands.
#
# Audit LOW-1 (2026-05-17): originally proposed an `__disabled__` sentinel
# but Codex Cyber review caught that this just leaks an invalid URL into
# the rendered driver.toml (driver's Url parser rejects it → driver fails
# to load at all rather than disabling V3 routing). The real audit concern
# was "operator sets `=` empty thinking they're disabling, gets default
# silently re-injected". Fix that directly: distinguish "unset" (= use
# default) from "set to empty" (= error). To actually disable V3 routing
# the operator should comment out the [[liquidity.uniswap-v3]] block in
# driver.toml.tmpl directly — it's a deliberate edit, not a runtime flag.
if [[ -n "${HYPERSWAP_V3_SUBGRAPH_URL+x}" ]] && [[ -z "$HYPERSWAP_V3_SUBGRAPH_URL" ]]; then
  echo "ERROR: HYPERSWAP_V3_SUBGRAPH_URL is set but empty." >&2
  echo "  - To use the default (Ormi-hosted) subgraph: unset the var or remove the line in .env." >&2
  echo "  - To use a custom subgraph: set HYPERSWAP_V3_SUBGRAPH_URL to its https URL." >&2
  echo "  - To DISABLE HyperSwap V3 routing entirely: comment out the [[liquidity.uniswap-v3]]" >&2
  echo "    block in infra/hyperevm-mainnet/configs/driver.toml.tmpl. Restart driver after." >&2
  exit 2
fi
: "${HYPERSWAP_V3_SUBGRAPH_URL:=https://api.subgraph.ormilabs.com/api/public/33c67399-d625-4929-b239-5709cd66e422/subgraphs/hyperswap-v3/v0.1.2/gn}"
export HYPERSWAP_V3_SUBGRAPH_URL

# Subgraph URL must look like a Goldsky-style or Ormi-style https
# endpoint. Sharp-edges audit (2026-05-17) noted the prior regex
# `^https://.+/[^/]+` was anchored only at the start — URLs with embedded
# whitespace, quotes, or newlines passed the check and broke TOML parsing
# downstream. The tightened pattern below:
#   - anchors both ends (^...$)
#   - restricts host chars to RFC-3986 reg-name + dots/hyphens
#   - allows an optional port (`:[0-9]+`)
#   - restricts the path body to RFC-3986-safe chars (alphanumerics,
#     unreserved punctuation, RFC sub-delims, and pct-encoding); the
#     real win is rejecting whitespace, quotes, backslashes, backticks,
#     control chars — sub-delim `$` is allowed because canonical URL
#     schemes may include it (envsubst doesn't expand inside the
#     resulting TOML string, so it's safe to pass through).
url_re='^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~!$&'\''()*+,;=:@%/?#-]+)+$'
if [[ ! "$HYPERSWAP_V3_SUBGRAPH_URL" =~ $url_re ]]; then
  echo "ERROR: HYPERSWAP_V3_SUBGRAPH_URL fails URL shape check (RFC-3986-safe https://host[:port]/path)" >&2
  exit 2
fi

# Sanity-check the driver-submitter PK shape (0x + 64 hex chars). A typo or
# accidental truncation lands as a soft-fail at driver startup; better to
# refuse here than ship a malformed rendered config to the container.
if [[ ! "$OPHIS_DRIVER_SUBMITTER_KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: OPHIS_DRIVER_SUBMITTER_KEY does not look like a 32-byte hex PK" >&2
  exit 2
fi

# Telegram bot tokens are `{int}:{base64-ish-suffix}`. A typo here means
# alerts silently disappear into a 404 — defeats the whole point of
# observability. Refuse at render time.
if [[ ! "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN doesn't look like a Telegram bot token ({int}:{base64-ish})" >&2
  exit 2
fi

mkdir -p rendered observability-rendered
shopt -s nullglob

for tmpl in configs/*.toml.tmpl configs/*.yaml.tmpl; do
  name="$(basename "$tmpl" .tmpl)"

  if [[ "$name" == "driver.toml" ]]; then
    # PK-bearing TOML — render to ophis-driver's private dir (Tier 1).
    TMP=$(mktemp); chmod 600 "$TMP"
    envsubst '${OPHIS_DRIVER_SUBMITTER_KEY}' < "$tmpl" > "$TMP"
    sudo install -m 600 -o ophis-driver -g staff "$TMP" "$OPHIS_RENDERED_DIR/driver.toml"
    rm -f "$TMP"
    echo "  rendered  $name → $OPHIS_RENDERED_DIR/driver.toml (owner ophis-driver)"
  else
    # Non-PK templates — render to ./rendered/ (scep-owned, 0600).
    out="rendered/$name"
    envsubst '${ALCHEMY_API_KEY} ${HYPEREVM_MAINNET_RPC} ${HYPEREVM_RPC_INTERNAL} ${HYPERSWAP_V3_SUBGRAPH_URL}' \
      < "$tmpl" > "$out"
    chmod 600 "$out"
    echo "  rendered  $name"
  fi
done

# Render observability templates (Alertmanager only — Prometheus config and
# alert rules are static and mounted as-is by docker-compose).
for tmpl in observability/*.yml.tmpl; do
  name="$(basename "$tmpl" .tmpl)"
  out="observability-rendered/$name"
  envsubst '${TELEGRAM_BOT_TOKEN}' < "$tmpl" > "$out"
  chmod 600 "$out"
  echo "  rendered  observability/$name"
done

# Telegram bot token in a chmod-600 file (Alertmanager reads via
# bot_token_file). Not env-var-injected — same hygiene as the
# driver-submitter PK (avoids `docker inspect` env leak).
TOKEN_FILE="observability-rendered/telegram-token"
printf '%s' "$TELEGRAM_BOT_TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "  rendered  observability/telegram-token (chmod 600, file-backed)"

# Same lock for .env — render-configs.sh runs at every deploy so this
# enforces idempotently.
[ -f .env ] && chmod 600 .env

echo ""
echo "OK. Rendered configs are in $SCRIPT_DIR/rendered/ — gitignored, mode 600."
echo "Bring up the stack with:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
