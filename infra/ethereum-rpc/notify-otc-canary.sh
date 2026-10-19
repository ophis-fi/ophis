#!/bin/sh
# Telegram message when the OTC check fails twice in a row, and when it passes again.
# ExecStopPost of ophis-otc-canary.service: systemd sets SERVICE_RESULT and
# STATE_DIRECTORY. The bot token and chat come from the indexer deployment .env.
set -u

state_file="${STATE_DIRECTORY:?systemd must supply STATE_DIRECTORY}/state"
env_file="${CANARY_ENV_FILE:-/srv/ophis/apps/rebate-indexer/.env}"
failures=0 alerted=0
[ -f "$state_file" ] && read -r failures alerted < "$state_file"

send() {
  token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$env_file" | tr -d "\"'")
  chat=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "$env_file" | tr -d "\"'")
  [ -n "$token" ] && [ -n "$chat" ] || return 1
  curl -fsS --max-time 15 -o /dev/null "https://api.telegram.org/bot$token/sendMessage" \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=$1"
}

if [ "${SERVICE_RESULT:-}" = success ]; then
  # Keep the state on a failed send so the next passing run retries the message.
  [ "$alerted" = 1 ] && { send "OTC check on $(hostname): passing again." || exit 0; }
  failures=0 alerted=0
else
  failures=$((failures + 1))
  if [ "$failures" -ge 2 ] && [ "$alerted" = 0 ] &&
    send "OTC check on $(hostname): failed $failures runs in a row (${SERVICE_RESULT:-unknown}). journalctl -u ophis-otc-canary.service"; then
    alerted=1
  fi
fi
printf '%s %s\n' "$failures" "$alerted" > "$state_file"
