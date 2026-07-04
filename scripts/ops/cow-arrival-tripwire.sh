#!/usr/bin/env bash
# CoW-arrival tripwire: weekly check for signals that CoW Protocol is about to
# launch (or has launched) hosted support on Ophis's sovereign chains
# (Optimism 10, Unichain 130). The sovereign positioning ("the only
# batch-auction venue on these chains, 100% fee keep") needs weeks of notice,
# not a surprise.
#
# Signals watched (ordered by how early they fire):
#   1. cow-sdk SupportedChainId promotion: Optimism/Unichain appearing inside
#      the SupportedChainId enum (sell-from) on cow-sdk main. Earliest public
#      code signal; today both are bridge-only (AdditionalTargetChainId).
#   2. cowswap networks.ts: the "bridge-only" stub comment for OPTIMISM
#      disappearing from main (frontend migration started).
#   3. barn.api.cow.fi/{optimism,unichain} flipping 404 -> 200: the staging
#      orderbook exists, launch is imminent (days to weeks).
#   4. api.cow.fi/{optimism,unichain} flipping 404 -> 200: launched.
#
# State: JSON at $STATE_FILE; alerts fire only on CHANGE (no weekly noise).
# Alerting: Telegram, bot token read from the macOS keychain entry
# "ophis-telegram-bot" (never echoed; see the token-hygiene block below).
# Portability: plain bash 3.2 (macOS default), no associative arrays.
#
# Install (launchd, weekly Monday 09:15 local):
#   see docs/operations/cow-arrival-tripwire.md
#
# Exit codes: 0 = ran (changes alerted if any); 2 = most checks could not run
# (network/API failure; NOT an arrival signal).

set -euo pipefail
umask 077

if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: the Telegram bot token would leak." >&2
  exit 2
fi

STATE_FILE="${STATE_FILE:-$HOME/.local/state/ophis/cow-tripwire.json}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-735726338}"
CURL="curl -sS --max-time 20"
UA="ophis-cow-tripwire/1.0 (+https://ophis.fi)"
KEYS="api_optimism api_unichain barn_optimism barn_unichain sdk_enum networks_stub"

mkdir -p "$(dirname "$STATE_FILE")"

# --- collectors ------------------------------------------------------------

http_status() { # $1 = url -> echoes status code, or "ERR"
  # Capture code and exit status separately so a failed probe yields exactly
  # "ERR", never a concatenation like "000ERR" (curl prints 000 on failure AND
  # exits nonzero). Only a clean 3-digit code passes through.
  local code rc
  code=$($CURL -o /dev/null -w '%{http_code}' -A "$UA" "$1" 2>/dev/null)
  rc=$?
  if [[ $rc -ne 0 || ! "$code" =~ ^[0-9]{3}$ || "$code" == "000" ]]; then
    echo "ERR"
  else
    echo "$code"
  fi
}

# Fetch a remote text file into a variable, or empty on failure. Isolated so
# the pipefail-sensitive parsing below never sees curl in its pipeline.
fetch_raw() { # $1 = url -> echoes body, or "" on any failure
  $CURL -A "$UA" "$1" 2>/dev/null || true
}

# cow-sdk: does the SupportedChainId enum block on main mention optimism/unichain?
sdk_signal() { # echoes e.g. "optimism=no unichain=no", or "ERR"
  local src block op un
  src=$(fetch_raw "https://raw.githubusercontent.com/cowprotocol/cow-sdk/main/packages/config/src/chains/types.ts")
  [[ -z "$src" ]] && { echo "ERR"; return; }
  # Anchor on the REAL exported declaration: the file opens with a commented-out
  # example enum of the same name, and the EvmChains enum legitimately lists
  # OPTIMISM as a bridge target; both are false-positive traps. Strip line
  # comments inside the block so an OPTIMISM mention in a comment cannot
  # false-positive. awk consumes the whole var (printf into it cannot SIGPIPE
  # because there is no early pipe exit here).
  block=$(awk '/^export enum SupportedChainId/{f=1} f{sub(/\/\/.*/,""); print} f&&/^\}/{exit}' <<< "$src")
  [[ -z "$block" ]] && { echo "ERR"; return; }
  # grep -c always exits 0 here via the || 0 guard; count matches on the
  # comment-stripped block.
  op=$(grep -ci "optimism" <<< "$block" || true)
  un=$(grep -ci "unichain" <<< "$block" || true)
  echo "optimism=$([[ ${op:-0} -gt 0 ]] && echo YES || echo no) unichain=$([[ ${un:-0} -gt 0 ]] && echo YES || echo no)"
}

# cowswap networks.ts: is the OPTIMISM bridge-only stub comment still there?
stub_signal() { # echoes "present", "GONE", or "ERR"
  local src hit
  src=$(fetch_raw "https://raw.githubusercontent.com/cowprotocol/cowswap/main/libs/common-const/src/networks.ts")
  [[ -z "$src" ]] && { echo "ERR"; return; }
  # Anchor to the OPTIMISM stub specifically: a line mentioning OPTIMISM that
  # also says bridge-only (or "future migration"). A bridge-only comment about
  # any other chain must not keep this "present". grep exit is captured, never
  # in a pipefail pipeline.
  hit=$(grep -iE 'optimism.*(bridge-only|future migration)|(bridge-only|future migration).*optimism' <<< "$src" || true)
  if [[ -n "$hit" ]]; then echo "present"; else echo "GONE"; fi
}

# --- run checks ------------------------------------------------------------

api_optimism=$(http_status "https://api.cow.fi/optimism/api/v1/version")
api_unichain=$(http_status "https://api.cow.fi/unichain/api/v1/version")
barn_optimism=$(http_status "https://barn.api.cow.fi/optimism/api/v1/version")
barn_unichain=$(http_status "https://barn.api.cow.fi/unichain/api/v1/version")
sdk_enum=$(sdk_signal)
networks_stub=$(stub_signal)

cur_of() { # $1 = key -> echoes its current value
  case "$1" in
    api_optimism) echo "$api_optimism" ;;
    api_unichain) echo "$api_unichain" ;;
    barn_optimism) echo "$barn_optimism" ;;
    barn_unichain) echo "$barn_unichain" ;;
    sdk_enum) echo "$sdk_enum" ;;
    networks_stub) echo "$networks_stub" ;;
  esac
}

# A wholesale collection failure is an ops problem, not a signal.
errs=0
for k in $KEYS; do [[ "$(cur_of "$k")" == "ERR" ]] && errs=$((errs + 1)); done
if [[ $errs -ge 4 ]]; then
  echo "tripwire: $errs/6 checks failed to run; skipping state update" >&2
  exit 2
fi

# --- diff against state ----------------------------------------------------
# State is a flat text file, one "key value" line per signal (value may
# contain spaces). No jq/python dependency, works on a stock macOS box.

prev_of() { # $1 = key -> echoes the stored value ('' if none)
  [[ -f "$STATE_FILE" ]] || return 0
  grep "^$1 " "$STATE_FILE" 2>/dev/null | head -1 | cut -d' ' -f2- || true
}

changes=""
if [[ -f "$STATE_FILE" ]]; then
  for k in $KEYS; do
    prev="$(prev_of "$k")"
    cur="$(cur_of "$k")"
    # Never alert on transitions into ERR (transient network noise); a
    # transition OUT of ERR only alerts if it differs from the last real value.
    if [[ "$cur" != "ERR" && -n "$prev" && "$prev" != "ERR" && "$cur" != "$prev" ]]; then
      changes="${changes}- ${k}: ${prev} -> ${cur}
"
    fi
  done
else
  echo "tripwire: first run, recording baseline (no alert)"
fi

# Persist current state atomically (keep last real value for keys now ERR).
tmp="${STATE_FILE}.tmp.$$"
{
  for k in $KEYS; do
    cur="$(cur_of "$k")"
    if [[ "$cur" == "ERR" ]]; then
      prev="$(prev_of "$k")"
      [[ -n "$prev" ]] && printf '%s %s\n' "$k" "$prev"
    else
      printf '%s %s\n' "$k" "$cur"
    fi
  done
  printf 'last_run %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$tmp"
mv "$tmp" "$STATE_FILE"

# --- alert on change --------------------------------------------------------

if [[ -n "$changes" ]]; then
  echo "tripwire: CHANGES DETECTED"
  printf '%s' "$changes"
  msg="COW ARRIVAL TRIPWIRE

Signals changed on CoW's side for the Ophis sovereign chains:

${changes}
Read: barn 200 = staging up, launch imminent. api 200 = LAUNCHED. sdk_enum YES = sell-from support merged upstream. networks_stub GONE = frontend migration started.

Playbook: weight sovereign messaging to Unichain, re-check docs claims of only-venue on the affected chain, and reassess the OP 100 percent fee-keep story."
  # Token hygiene: the Telegram API requires the token in the URL path, but the
  # URL must NOT appear in argv (visible via `ps` while curl runs). Pass it
  # through a curl config on stdin (curl -K -), so the token stays out of the
  # process command line, out of `set -x` (blocked above anyway), and out of any
  # log. The token is read into a variable, never echoed, and cleared after use.
  BOT_TOKEN=$(security find-generic-password -s ophis-telegram-bot -w 2>/dev/null || true)
  if [[ -n "${BOT_TOKEN:-}" ]]; then
    # The token-bearing URL is fed through curl's stdin config (-K -), so it
    # never appears in argv. The message and chat_id are not secret and stay on
    # the command line. curl reads only the `url` line from stdin.
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$BOT_TOKEN" \
      | $CURL -o /dev/null -X POST -K - \
          --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
          --data-urlencode "text=${msg}" \
      || echo "tripwire: telegram send failed" >&2
    BOT_TOKEN=""
  else
    echo "tripwire: no telegram token in keychain; change logged only" >&2
  fi
else
  echo "tripwire: no changes ($(date '+%Y-%m-%d %H:%M'))"
fi
