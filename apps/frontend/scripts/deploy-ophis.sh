#!/usr/bin/env bash
# Deploy cowswap-frontend to the `greg` Cloudflare Pages project (ophis.fi).
#
# Why this script exists (2026-05-20 deploy incident):
#   - The FE build output at apps/frontend/build/cowswap/ does NOT include
#     the CF Pages Functions (~/greg/functions/ at repo root). A naive
#     `wrangler pages deploy build/cowswap` ships ONLY the static assets
#     and silently strips /api/intent from production.
#   - Even copying functions/ into build/cowswap/ mid-deploy doesn't help:
#     CF Pages caches "functions presence" per project at first detection.
#     Re-deploying without the Worker-compile signal in the output leaves
#     the cached "no functions" state untouched.
#   - The keychain CF API token has `pages:write` + `account:read` but
#     NOT `user:memberships:read`. Without explicit CLOUDFLARE_ACCOUNT_ID,
#     wrangler tries to auto-discover via /memberships → AuthError 10000.
#
# Working incantation (confirmed 2026-05-20):
#   1. Stage a clean dir with build/cowswap/* + functions/ alongside
#   2. Set CLOUDFLARE_ACCOUNT_ID explicitly (don't rely on /memberships)
#   3. wrangler pages deploy with --branch main
#   4. Confirm "Compiled Worker successfully" + "Uploading Functions bundle"
#      appear in the output before declaring success.
#
# Optional source-map strip: deployments >25 MiB fail CF Pages limit;
# stripping .map files keeps under the cap AND removes a security smell
# (prod source maps expose Ophis source code).

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FE_BUILD="$REPO_ROOT/apps/frontend/build/cowswap"
FUNCTIONS_SRC="$REPO_ROOT/functions"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-4761b41ef352631db0ed367fea98ffdc}"
PROJECT="${OPHIS_PAGES_PROJECT:-greg}"

# Stage dir — audit (codex 2026-05-20 HIGH): the previous shape
# `STAGE=${OPHIS_DEPLOY_STAGE:-/tmp/ophis-deploy-stage}` followed by
# `rm -rf "$STAGE"` is dangerous if the env var resolves to `/`, `$HOME`,
# or the repo root via expansion tricks. Use mktemp by default; if a
# user-supplied override is provided, validate it before destruction.
if [[ -n "${OPHIS_DEPLOY_STAGE:-}" ]]; then
  STAGE="$OPHIS_DEPLOY_STAGE"
  # Reject obviously dangerous targets
  case "$STAGE" in
    "/"|""|"$HOME"|"$HOME/"|"$REPO_ROOT"|"$REPO_ROOT/")
      echo "ERROR: refuse to use \$OPHIS_DEPLOY_STAGE='$STAGE' (dangerous)" >&2
      exit 1
      ;;
  esac
  # Allow ONLY paths matching /tmp/ophis-* or /var/folders/.../ophis-*.
  # Codex pre-deploy audit (2026-05-20) flagged the prior `/tmp/*` /
  # `/var/folders/*` permissive globs: STAGE=/tmp/ (bare, no subdir)
  # would have made `rm -rf $STAGE` = `rm -rf /tmp/`. Now we require a
  # non-empty `ophis-`-prefixed subdir.
  case "$STAGE" in
    /tmp/ophis-*|/var/folders/*/ophis-*) ;;
    *)
      echo "ERROR: \$OPHIS_DEPLOY_STAGE must match /tmp/ophis-* or /var/folders/.../ophis-*" >&2
      echo "       got: '$STAGE'" >&2
      exit 1
      ;;
  esac
else
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/ophis-deploy-stage.XXXXXX")
fi

if [[ ! -d "$FE_BUILD" ]]; then
  echo "ERROR: FE build not found at $FE_BUILD" >&2
  echo "       Run 'pnpm run build:cowswap' from apps/frontend first." >&2
  exit 1
fi
if [[ ! -d "$FUNCTIONS_SRC" ]]; then
  echo "ERROR: functions dir not found at $FUNCTIONS_SRC" >&2
  exit 1
fi

# Resolve CF API token from Keychain via subshell capture (never echo!).
# See feedback_never_dump_keychain_token_to_stdout for the why.
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  TOKEN=$(security find-generic-password -s "cloudflare-api-token" -w 2>/dev/null || true)
  if [[ -z "$TOKEN" ]]; then
    echo "ERROR: cloudflare-api-token not in keychain and \$CLOUDFLARE_API_TOKEN unset" >&2
    exit 2
  fi
  export CLOUDFLARE_API_TOKEN="$TOKEN"
  unset TOKEN
fi
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

echo "Staging clean deploy dir at $STAGE …"
# Belt-and-suspenders: STAGE was validated above, but never `rm -rf` an
# empty / root-like target. mktemp gives us a non-empty path by default.
[[ -n "$STAGE" && "$STAGE" != "/" && "$STAGE" != "$HOME" ]] || {
  echo "ERROR: STAGE='$STAGE' rejected (would rm root/home)" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Copy FE build (rsync handles hidden files cleanly).
rsync -a --include='.well-known' --include='.well-known/**' \
  "$FE_BUILD/" "$STAGE/"

# Strip source maps: CF Pages 25MiB/file limit + prod security smell.
local_maps=$(find "$STAGE" -name "*.map" | wc -l | awk '{print $1}')
if (( local_maps > 0 )); then
  echo "Stripping $local_maps source maps before deploy …"
  find "$STAGE" -name "*.map" -delete
fi

# Place functions/ at deploy root (CF Pages auto-detects).
# Defensive cleanup (2026-05-20): if the rsync from $FE_BUILD brought
# in a stale `functions/` (e.g. an earlier debugging session left one
# inside build/cowswap/), `cp -r` would NEST it as
# `$STAGE/functions/functions/` and CF Pages would see the stale
# top-level one. Delete first, then copy fresh.
rm -rf "$STAGE/functions"
cp -r "$FUNCTIONS_SRC" "$STAGE/functions"

# Write _routes.json. `include` controls which URL paths invoke
# Functions — anything not listed is served directly by the static
# asset handler, skipping Functions entirely (perf + cost win).
#
# We include:
#   - `/api/*`  — the intent parser at functions/api/intent.ts
#   - `/`       — required so the root-only middleware in
#                 functions/_middleware.ts fires on docs.ophis.fi/
#                 and business.ophis.fi/. Without this, the hostname
#                 rewrite is skipped and visitors fall through to
#                 the SPA's defensive React hook
#                 (useSubdomainRedirect), which client-bounces to
#                 /docs/ and brings back the "useless URL extension"
#                 UX. Added 2026-05-23 alongside the middleware ship.
cat > "$STAGE/_routes.json" <<EOF
{
  "version": 1,
  "include": ["/", "/api/*", "/sitemap.xml", "/robots.txt"],
  "exclude": []
}
EOF

echo "Deploy dir staged. Layout:"
echo "  Total size:   $(du -sh "$STAGE" | awk '{print $1}')"
echo "  Static files: $(find "$STAGE" -maxdepth 2 -type f -not -path '*/functions/*' | wc -l | awk '{print $1}')"
echo "  Function files: $(find "$STAGE/functions" -name '*.ts' -o -name '*.js' | wc -l | awk '{print $1}')"
echo ""

# Deploy. Critical flags:
#   --branch main → goes straight to Production (this project's prod branch)
#   --commit-dirty=true → required for ad-hoc (non-CI) deploys
#   --project-name → CF Pages project name (greg = ophis.fi)
cd "$STAGE"
echo "Deploying to CF Pages project '$PROJECT' …"
wrangler pages deploy . \
  --project-name "$PROJECT" \
  --branch main \
  --commit-dirty=true

# Scrub the token from env so post-deploy curl checks (and any
# CF-misconfigured proxy that might log) never see it. Audit MED
# (sharp-edges 2026-05-20).
unset CLOUDFLARE_API_TOKEN

echo ""
echo "Post-deploy sanity check (give CF a few seconds to propagate):"
sleep 6

INTENT_STATUS=$(curl -s -X POST "https://ophis.fi/api/intent" \
  -H 'Content-Type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}' \
  -o /dev/null -w '%{http_code}')
# --compressed so we never get a gzipped body that breaks the grep
# (sharp-edges MED 2026-05-20). Empty result triggers a warn below.
BUNDLE_HASH=$(curl -s --compressed https://ophis.fi 2>&1 | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)

echo "  /api/intent status: $INTENT_STATUS (expected: 200)"
echo "  bundle hash:        ${BUNDLE_HASH:-<extract-failed>}"
[[ -z "$BUNDLE_HASH" ]] && echo "  WARN: bundle hash extraction returned empty — check response shape"

if [[ "$INTENT_STATUS" != "200" ]]; then
  echo ""
  echo "❌ /api/intent didn't respond 200 — function may not have shipped."
  echo "   Verify the wrangler output above included:"
  echo "     ✨ Compiled Worker successfully"
  echo "     ✨ Uploading Functions bundle"
  echo "   If those are missing, the function bundle didn't compile."
  exit 3
fi

echo ""
echo "✅ Deploy verified. ophis.fi is live with /api/intent + the new bundle."
