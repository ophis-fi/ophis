#!/usr/bin/env bash
set -euo pipefail
umask 077

base=${1:?Pass the private operator installation directory}
mode=${2:-critical}
[[ "$mode" = critical || "$mode" = full ]]
[[ "$base" = /* && -d "$base/state" && -f "$base/backup-cert.pem" ]]
mkdir -p "$base/backups"
exec 9>"$base/backup.lock"
flock -n 9 || { echo 'Another operator backup is running.' >&2; exit 1; }
compose=(docker compose --env-file "$base/compose.env" -f "$base/current/compose.yml")
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
  source=$base
else
  [[ -n "$running" && -f "$base/state/secrets/operator.sealed.json" ]]
  snapshot=$(mktemp -d "$base/state/.backup-snapshot.XXXXXXXX")
  "${compose[@]}" exec -T broadcaster node dist/main.mjs snapshot "/var/lib/ophis-broadcaster/${snapshot##*/}"
  cp -- "$base/operator.env" "$base/compose.env" "$snapshot/"
  source=$snapshot
fi
tar -C "$source" -cf - state operator.env compose.env |
  openssl cms -encrypt -binary -aes-256-gcm -outform DER -recip "$base/backup-cert.pem" \
    -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 -out "$temporary"
completed="$base/backups/backup-$(date -u +%Y%m%dT%H%M%SZ)-${temporary##*.}.cms"
mv -- "$temporary" "$completed"
printf '%s\n' "$completed"
