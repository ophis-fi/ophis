#!/usr/bin/env bash
# Ophis OP mainnet — daily Postgres backup.
#
# Closes the "no backup exists" Blocker from the 2026-05-19 prod-readiness
# review. Without this, a Mac mini failure = full loss of orderbook /
# autopilot state (~30 days of orders, quotes, settlement metadata).
#
# Design:
#   1. ALWAYS write a local backup under $BACKUP_DIR (default
#      $HOME/.local/state/ophis/pg-backups/). Mode 0600. Retention is
#      handled locally: keep the last $LOCAL_RETENTION_DAYS days, delete
#      older.
#   2. If $REMOTE_BACKUP_CMD is set in the operator's env, also pipe the
#      latest dump to that command. This lets the operator enable cloud
#      uploads (B2 / S3 / scp to a friend's NAS) without changing the
#      script. Examples:
#        REMOTE_BACKUP_CMD='b2 upload-file --noProgress ophis-backups -'
#        REMOTE_BACKUP_CMD='aws s3 cp - s3://ophis-backups/op/'
#        REMOTE_BACKUP_CMD='rclone rcat ophis-remote:backups/op/$(date +%F).pgdump'
#      The command receives the dump on stdin.
#   3. Logs to ~/Library/Logs/ophis-postgres-backup.log + launchd capture.
#
# Threat-model notes:
#   - Local backup is on the SAME SSD as the live db → does NOT protect
#     against SSD/host failure. That's why the optional remote upload
#     matters for true DR (see docs/operations/disaster-recovery-runbook.private.md).
#   - Local backup is mode 0600 owner scep. Postgres dump format -Fc
#     (compressed binary, with pg_dump's own structure) — not human-
#     readable but trivially decompressed. Treat as semi-sensitive
#     (contains orderbook / partner-fee data; no PKs).
#   - The dump file does NOT contain the driver-submitter PK — that's
#     in /Users/ophis-driver/.config/submitter.key, separate runbook
#     (submitter-pk-backup-runbook.private.md).

set -euo pipefail
umask 077

# Defaults — operator can override via env or .env in script dir.
BACKUP_DIR="${OPHIS_PG_BACKUP_DIR:-$HOME/.local/state/ophis/pg-backups}"
LOCAL_RETENTION_DAYS="${OPHIS_PG_BACKUP_RETENTION_DAYS:-14}"
DB_CONTAINER="${OPHIS_PG_BACKUP_CONTAINER:-optimism-mainnet-db-1}"
DB_USER="${OPHIS_PG_BACKUP_USER:-ophis}"
DB_NAME="${OPHIS_PG_BACKUP_DB:-ophis}"
LOG_FILE="${OPHIS_PG_BACKUP_LOG:-$HOME/Library/Logs/ophis-postgres-backup.log}"

# Sharp-edges HIGH-2: validate BACKUP_DIR doesn't resolve to a dangerous
# system path. A typo like OPHIS_PG_BACKUP_DIR= (empty) → expansion to /
# would have us `chmod 700 /` and run `find / -name op-*.pgdump -mtime
# +N -delete` — catastrophic. Resolve to absolute, refuse if dangerous.
case "$BACKUP_DIR" in
  ""|"/"|"/Users"|"$HOME"|"$HOME/"|/tmp|/var)
    echo "ERROR: BACKUP_DIR='$BACKUP_DIR' is too broad — refuse to operate here." >&2
    exit 10
    ;;
esac
# Resolve to absolute. realpath -m allows non-existent (we mkdir below).
BACKUP_DIR=$(cd "$(dirname "$BACKUP_DIR")" 2>/dev/null && pwd)/"$(basename "$BACKUP_DIR")" || {
  echo "ERROR: BACKUP_DIR parent doesn't exist: '$BACKUP_DIR'" >&2
  exit 10
}
# Final guard: must contain "ophis" substring (defensive — keeps a typo
# from pointing at an unrelated user dir).
case "$BACKUP_DIR" in
  *ophis*) : ;;  # OK
  *)
    echo "ERROR: BACKUP_DIR='$BACKUP_DIR' doesn't contain 'ophis' — refusing." >&2
    echo "       Set OPHIS_PG_BACKUP_DIR to a path under \$HOME/.local/state/ophis/..." >&2
    exit 10
    ;;
esac

# Sharp-edges MED-1: validate retention is an integer ≥ 1. Else `find
# -mtime +0` deletes everything older than 24h INCLUDING today's
# straddling a day boundary.
if [[ ! "$LOCAL_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: LOCAL_RETENTION_DAYS='$LOCAL_RETENTION_DAYS' must be a positive integer." >&2
  exit 10
fi

# Refuse to run under `set -x` — the REMOTE_BACKUP_CMD env may contain
# tokens that would leak in the trace.
if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: REMOTE_BACKUP_CMD may contain credentials." >&2
  exit 2
fi

log() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "[$ts] $*" >> "$LOG_FILE"
  echo "[$ts] $*"
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

DATE=$(date +%F)
EPOCH=$(date +%s)
OUT="$BACKUP_DIR/op-${DATE}.pgdump"
OUT_TMP="$OUT.tmp.$$"

log "starting Postgres dump of $DB_NAME from container $DB_CONTAINER"

# Verify the container is running before attempting dump. pg_dump against
# a stopped container would just produce an empty file.
if ! docker ps --filter "name=^${DB_CONTAINER}$" --filter "status=running" --format '{{.Names}}' | grep -qFx "$DB_CONTAINER"; then
  log "ERROR: container $DB_CONTAINER is not running. Aborting backup."
  exit 3
fi

# Dump with -Fc (custom format, compressed, restorable via pg_restore).
# --no-owner / --no-privileges so the dump can be restored into a db
# with different ownership semantics (DR scenario).
if ! docker exec "$DB_CONTAINER" pg_dump -Fc --no-owner --no-privileges \
       -U "$DB_USER" "$DB_NAME" > "$OUT_TMP"; then
  log "ERROR: pg_dump failed. Cleaning up partial $OUT_TMP."
  rm -f "$OUT_TMP"
  exit 4
fi

# Sanity: a healthy dump is at least a few KB (custom format has a
# binary header). An empty/0-byte file means pg_dump succeeded but
# returned nothing (shouldn't happen but defense in depth).
size=$(wc -c < "$OUT_TMP" | tr -d ' ')
if (( size < 1024 )); then
  log "ERROR: dump is only $size bytes — suspiciously small. Aborting."
  rm -f "$OUT_TMP"
  exit 5
fi

chmod 600 "$OUT_TMP"
mv -f "$OUT_TMP" "$OUT"
log "wrote $OUT ($size bytes)"

# Sharp-edges MED-3: pg_dump can return 0 with a partially-flushed
# binary dump if the container exits mid-stream. The size-check above
# catches "completely empty"; pg_restore --list catches "valid header
# but truncated TOC". Cheap deterministic check.
#
# 2026-05-20 fix: prior version used `docker exec ... < $OUT`. Without
# `-i`, docker doesn't pipe stdin → pg_restore reads empty → false
# "corrupt" verdict on every dump. Switched to docker cp + container-
# side path → pg_restore on actual file. Reliable across docker
# versions + binary-safe.
VALIDATION_PATH="/tmp/.pg-validate.${$}.pgdump"
docker cp "$OUT" "${DB_CONTAINER}:${VALIDATION_PATH}" >/dev/null
if ! docker exec "$DB_CONTAINER" pg_restore --list "$VALIDATION_PATH" >/dev/null 2>&1; then
  log "ERROR: pg_restore --list rejected the dump — file is corrupt/truncated. Aborting."
  docker exec "$DB_CONTAINER" rm -f "$VALIDATION_PATH" >/dev/null 2>&1 || true
  # Don't delete the dump — operator may want to inspect.
  # Just rename so subsequent restore commands don't accidentally pick
  # a known-bad file.
  mv "$OUT" "${OUT}.CORRUPT"
  log "  renamed to ${OUT}.CORRUPT for forensics"
  exit 11
fi
docker exec "$DB_CONTAINER" rm -f "$VALIDATION_PATH" >/dev/null 2>&1 || true
log "dump validated via pg_restore --list"

# Optional remote upload. Set OPHIS_PG_REMOTE_BACKUP_CMD in the operator's
# .env or launchd EnvironmentVariables to enable. The command receives
# the dump on stdin.
if [[ -n "${OPHIS_PG_REMOTE_BACKUP_CMD:-}" ]]; then
  log "attempting remote backup via OPHIS_PG_REMOTE_BACKUP_CMD"
  if ! bash -c "$OPHIS_PG_REMOTE_BACKUP_CMD" < "$OUT"; then
    log "WARNING: remote backup command failed. Local backup at $OUT is still valid."
    # NOT a fatal error — local backup succeeded. Operator should investigate
    # but the system is no worse off than the pre-remote-config state.
  else
    log "remote backup OK"
  fi
else
  log "OPHIS_PG_REMOTE_BACKUP_CMD not set — local-only backup. See"
  log "  docs/operations/disaster-recovery-runbook.private.md for cloud setup."
fi

# Retention: delete local dumps older than $LOCAL_RETENTION_DAYS.
# Use -mtime +N (file modified MORE than N days ago).
# We expand-then-delete with explicit print for the log trail.
log "pruning local dumps older than $LOCAL_RETENTION_DAYS days"
old_count=0
while IFS= read -r -d '' f; do
  log "  pruning $f"
  rm -f "$f"
  old_count=$((old_count + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "op-*.pgdump" -mtime +"$LOCAL_RETENTION_DAYS" -print0 2>/dev/null)
log "pruned $old_count old dump(s)"

log "done. Retention summary:"
ls -lh "$BACKUP_DIR"/op-*.pgdump 2>/dev/null | tail -5 | while read -r line; do
  log "  $line"
done

# Don't exit non-zero just because there's nothing to prune.
log "OK"
