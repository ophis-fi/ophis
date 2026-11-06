#!/usr/bin/env bash
set -euo pipefail
umask 077

base=${1:?Pass the private operator installation directory}
mode=${2:-critical}
[[ "$mode" = critical || "$mode" = full ]]
[[ "$base" = /* && -d "$base" && -f "$base/backup-cert.pem" ]]
mkdir -p "$base/backups"
exec 9>"$base/backup.lock"
flock -n 9 || { echo 'Another operator backup is running.' >&2; exit 1; }
compose=(docker compose --env-file "$base/compose.env" -f "$base/current/compose.yml")
state=$("${compose[@]}" config --format json | python3 -I -c '
import json, os, sys
try:
    volumes = json.load(sys.stdin)["services"]["broadcaster"]["volumes"]
    selected = [v for v in volumes if v.get("target") == "/var/lib/ophis-broadcaster"]
    if len(selected) != 1 or selected[0].get("type") != "bind":
        raise ValueError()
    source = selected[0]["source"]
    if not isinstance(source, str) or not os.path.isabs(source) or "\n" in source or "\r" in source:
        raise ValueError()
    source = os.path.normpath(source)
    if source == "/":
        raise ValueError()
    print(source)
except (KeyError, TypeError, ValueError, AttributeError):
    sys.exit("Cannot resolve the configured broadcaster state bind mount.")
')
if [[ ! -d "$state" || -L "$state" ]]; then
  echo 'Configured broadcaster state must be a real directory, not a symlink.' >&2
  exit 1
fi
running=$("${compose[@]}" ps --status running -q broadcaster)
temporary=$(mktemp "$base/backups/.incomplete.XXXXXXXX")
snapshot=
stopped=
cleanup() {
  rm -f -- "$temporary"
  if [[ -n "$snapshot" ]]; then rm -rf -- "$snapshot"; fi
  if [[ -n "$stopped" ]]; then "${compose[@]}" start broadcaster; fi
}
trap cleanup EXIT
if [[ "$mode" = full ]]; then
  stopped=$running
  "${compose[@]}" stop broadcaster
  source=${state%/*}
  source=${source:-/}
  # Full archives retain the configured directory basename, including owner-state.
  entries=("./${state##*/}" -C "$base" operator.env compose.env)
else
  [[ -n "$running" && -f "$state/secrets/operator.sealed.json" ]]
  snapshot=$(mktemp -d "$state/.backup-snapshot.XXXXXXXX")
  "${compose[@]}" exec -T broadcaster node dist/main.mjs snapshot "/var/lib/ophis-broadcaster/${snapshot##*/}"
  cp -- "$base/operator.env" "$base/compose.env" "$snapshot/"
  source=$snapshot
  # Critical snapshots normalize their contents to state/; restore to the configured mount.
  entries=(state operator.env compose.env)
fi
tar -C "$source" -cf - "${entries[@]}" |
  openssl cms -encrypt -binary -aes-256-gcm -outform DER -recip "$base/backup-cert.pem" \
    -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 -out "$temporary"
completed="$base/backups/backup-$(date -u +%Y%m%dT%H%M%SZ)-${temporary##*.}.cms"
mv -- "$temporary" "$completed"
printf '%s\n' "$completed"
