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
container=$("${compose[@]}" ps -aq broadcaster)
if [[ -z "$container" || "$container" = *$'\n'* ]]; then
  echo 'Backup requires exactly one existing broadcaster container.' >&2
  exit 1
fi
mounted=$(docker inspect --format '{{json .Mounts}}' "$container" | python3 -I -c '
import json, os, sys
try:
    selected = [v for v in json.load(sys.stdin) if v.get("Destination") == "/var/lib/ophis-broadcaster"]
    if len(selected) != 1 or selected[0].get("Type") != "bind":
        raise ValueError()
    source = selected[0]["Source"]
    if not isinstance(source, str) or not os.path.isabs(source) or "\n" in source or "\r" in source:
        raise ValueError()
    print(source)
except (KeyError, TypeError, ValueError, AttributeError):
    sys.exit("Cannot resolve the existing broadcaster state bind mount.")
')
if [[ ! "$mounted" -ef "$state" ]]; then
  echo 'Existing broadcaster state mount differs from the configured state.' >&2
  exit 1
fi
if [[ ! -f "$state/requests.sqlite" || ! -f "$state/secrets/operator.sealed.json" ]]; then
  echo 'Broadcaster state is missing its request journal or sealed operator record.' >&2
  exit 1
fi
running=$("${compose[@]}" ps --status running -q broadcaster)
if [[ -n "$running" && "$running" != "$container" ]]; then
  echo 'Running broadcaster does not match the inspected container.' >&2
  exit 1
fi
if [[ "$mode" = critical && -z "$running" ]]; then
  echo 'Critical backup requires the existing broadcaster to be running.' >&2
  exit 1
fi
temporary=
snapshot=
stopped=
restore_marker=
challenge=
cleanup() {
  if [[ -n "$challenge" ]]; then rm -f -- "$challenge"; fi
  if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi
  if [[ -n "$snapshot" ]]; then rm -rf -- "$snapshot"; fi
  if [[ -n "$restore_marker" ]]; then rm -f -- "$restore_marker"; fi
  if [[ -n "$stopped" ]]; then "${compose[@]}" start broadcaster; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Docker's reported Source can name a replacement directory or a different daemon host.
# Read a fresh challenge through the container's actual mount before stopping or archiving.
challenge=$(mktemp "$state/.backup-mount-check.XXXXXXXX")
expected=$(python3 -I -c 'import secrets; print(secrets.token_hex(32))')
python3 -I - "$challenge" "$expected" <<'PY'
import os, stat, sys
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size != 0:
        sys.exit('Unsafe backup mount challenge.')
    os.write(fd, sys.argv[2].encode('ascii'))
    os.fsync(fd)
finally:
    os.close(fd)
PY
challenge_path="/var/lib/ophis-broadcaster/${challenge##*/}"
challenge_user="$(id -u):$(id -g)"
read_challenge='const fs=require("node:fs");const fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&511)!==384||s.nlink!==1||s.size!==64)throw Error("Invalid mount challenge");const value=fs.readFileSync(fd,"ascii");if(!/^[0-9a-f]{64}$/.test(value))throw Error("Invalid mount challenge");process.stdout.write(value)}finally{fs.closeSync(fd)}'
if [[ -n "$running" ]]; then
  observed=$(docker exec --user "$challenge_user" "$container" node -e "$read_challenge" "$challenge_path") || {
    echo 'Cannot verify the existing container state mount.' >&2; exit 1;
  }
else
  image=$(docker inspect --format '{{.Image}}' "$container")
  if [[ ! "$image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo 'Stopped-container mount verification requires its immutable image ID.' >&2
    exit 1
  fi
  observed=$(docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$challenge_user" --volumes-from "$container:ro" --entrypoint node "$image" -e "$read_challenge" "$challenge_path") || {
    echo 'Cannot verify the stopped container state mount.' >&2; exit 1;
  }
fi
if [[ "$observed" != "$expected" ]]; then
  echo 'Container-mounted state differs from the configured host directory.' >&2
  exit 1
fi
rm -f -- "$challenge"
challenge=
temporary=$(mktemp "$base/backups/.incomplete.XXXXXXXX")
if [[ "$mode" = full ]]; then
  stopped=$running
  "${compose[@]}" stop broadcaster
  # Keep restored prepaid journals unarmed until missing attempts and refunds are recovered.
  if [[ ! -e "$state/.prepaid-restore-review-required" && ! -L "$state/.prepaid-restore-review-required" ]]; then
    ( set -o noclobber; printf '%s\n' 'Full backup: reconcile credit history before signing.' > "$state/.prepaid-restore-review-required" )
    restore_marker="$state/.prepaid-restore-review-required"
  fi
  source=${state%/*}
  source=${source:-/}
  # Full archives retain the configured directory basename, including owner-state.
  entries=("./${state##*/}" -C "$base" operator.env compose.env)
else
  [[ -n "$running" && -f "$state/secrets/operator.sealed.json" ]]
  snapshot=$(mktemp -d "$state/.backup-snapshot.XXXXXXXX")
  "${compose[@]}" exec -T broadcaster node dist/main.mjs snapshot "/var/lib/ophis-broadcaster/${snapshot##*/}"
  source=$snapshot
  # Critical snapshots normalize their contents to state/; restore to the configured mount.
  entries=(state -C "$base" operator.env compose.env)
fi
tar -C "$source" -cf - "${entries[@]}" |
  openssl cms -encrypt -binary -aes-256-gcm -outform DER -recip "$base/backup-cert.pem" \
    -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 -out "$temporary"
completed="$base/backups/backup-$(date -u +%Y%m%dT%H%M%SZ)-${temporary##*.}.cms"
mv -- "$temporary" "$completed"
printf '%s\n' "$completed"
