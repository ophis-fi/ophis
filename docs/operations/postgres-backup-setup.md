# Postgres backup setup

**Audience:** operator (Clement / successor) enabling the daily Postgres backup.
**Last updated:** 2026-05-20.
**Related:** `docs/operations/disaster-recovery-runbook.private.md` (Step 5)

## What this does

Daily at **03:30 local time**, the LaunchAgent at
`~/Library/LaunchAgents/ai.ophis.postgres-backup.plist` runs the script
at `infra/shared/cron/postgres-backup.sh`, which:

1. Runs `docker exec optimism-mainnet-db-1 pg_dump -Fc -U ophis ophis`
2. Writes the dump to `$HOME/.local/state/ophis/pg-backups/op-YYYY-MM-DD.pgdump`
3. Keeps last **14 days** of dumps locally, prunes older
4. **Optionally** uploads to S3 / B2 / rclone / etc. — operator-configured

## One-time setup (initial enable)

```bash
# 1. Make script executable (should already be after git pull)
chmod +x ~/greg/infra/shared/cron/postgres-backup.sh

# 2. Run once manually to verify
~/greg/infra/shared/cron/postgres-backup.sh
# Expect: writes $HOME/.local/state/ophis/pg-backups/op-2026-MM-DD.pgdump
#         logs to ~/Library/Logs/ophis-postgres-backup.log

# 3. Copy plist into LaunchAgents dir
cp ~/greg/infra/shared/cron/ai.ophis.postgres-backup.plist ~/Library/LaunchAgents/

# 4. Load it
launchctl load ~/Library/LaunchAgents/ai.ophis.postgres-backup.plist

# 5. Verify it's loaded
launchctl list | grep ai.ophis.postgres-backup
```

After step 5, the backup runs daily at 03:30. To trigger manually:

```bash
launchctl start ai.ophis.postgres-backup
```

To check the most recent run:

```bash
tail ~/Library/Logs/ophis-postgres-backup.log
ls -lh ~/.local/state/ophis/pg-backups/
```

## Enabling cloud uploads (recommended for real DR)

Local-only backups do NOT survive a Mac mini failure — that's the whole point of the DR runbook. To get true off-site backup, pick ONE of:

### Option A: Backblaze B2 (cheapest — ~$0.006/GB/mo, $0/mo for ≤10 GB)

```bash
# 1. Install the B2 CLI
brew install backblaze-b2

# 2. Create a B2 account at backblaze.com, generate an Application Key
#    with capability: writeFiles on a NEW bucket named ophis-backups.
b2 account authorize <KEY_ID> <APP_KEY>

# 3. Verify
b2 bucket list

# 4. Add lifecycle policy to delete old uploads (30 days)
b2 bucket update ophis-backups allPrivate \
  --lifecycleRules '[{"fileNamePrefix":"","daysFromUploadingToHiding":30,"daysFromHidingToDeleting":1}]'

# 5. Edit ~/Library/LaunchAgents/ai.ophis.postgres-backup.plist
#    Add inside <key>EnvironmentVariables</key><dict>:
#      <key>OPHIS_PG_REMOTE_BACKUP_CMD</key>
#      <string>b2 file upload --quiet ophis-backups - op-$(date +%Y-%m-%d).pgdump</string>
#    NOTE: b2 reads auth from $HOME/.b2_account_info — make sure the
#    LaunchAgent's user can read that file (it's chmod 600 by default).

# 6. Reload
launchctl unload ~/Library/LaunchAgents/ai.ophis.postgres-backup.plist
launchctl load ~/Library/LaunchAgents/ai.ophis.postgres-backup.plist
launchctl start ai.ophis.postgres-backup
```

Estimated cost: ~$0/mo for the first ~10 GB. At ~50 MB / day with 30-day retention, that's ~1.5 GB stored — well under the free tier.

### Option B: AWS S3 (more expensive — pay-per-byte from byte 0)

Same idea with `aws s3 cp - s3://your-bucket/op/dump-$(date +%F).pgdump`. Set up an S3 bucket with lifecycle policies for 30-day expiry. Cost: ~$0.10/mo for our volume.

### Option C: rclone to a friend's NAS / Hetzner Storage Box (~€3/mo)

```bash
brew install rclone
rclone config   # set up the remote
# Then in EnvironmentVariables:
#   OPHIS_PG_REMOTE_BACKUP_CMD = rclone rcat ophis-remote:backups/op/$(date +%F).pgdump
```

### Option D: Encrypted USB stick (manual, no recurring cost)

If you want zero cloud spend, write a separate weekly job that copies the local backup dir to a USB drive. Drawback: requires plugging the USB in, not a true automated DR.

## Restore procedure

Documented at length in `docs/operations/disaster-recovery-runbook.private.md` Step 5. Quick version:

```bash
# Local restore (use most recent dump)
LATEST=$(ls -t ~/.local/state/ophis/pg-backups/op-*.pgdump | head -1)
BASENAME=$(basename "$LATEST")
docker cp "$LATEST" "optimism-mainnet-db-1:/tmp/$BASENAME"
docker exec -u postgres optimism-mainnet-db-1 \
  pg_restore -d ophis -U ophis --clean --if-exists "/tmp/$BASENAME"

# Remote restore from B2
LATEST_REMOTE=$(b2 ls --json ophis-backups | jq -r 'sort_by(.uploadTimestamp) | reverse | .[0].fileName')
b2 file download "b2://ophis-backups/$LATEST_REMOTE" /tmp/restore.pgdump
docker cp /tmp/restore.pgdump optimism-mainnet-db-1:/tmp/restore.pgdump
docker exec -u postgres optimism-mainnet-db-1 pg_restore -d ophis -U ophis --clean --if-exists /tmp/restore.pgdump
```

## Verifying backup health (do quarterly)

Bit-rot on local SSDs is real over multi-year horizons. Pick a random dump from ≥1 month ago, restore it into a scratch DB, verify it parses cleanly:

```bash
# Create scratch db
docker exec -u postgres optimism-mainnet-db-1 createdb -U ophis ophis_restore_test

# Restore (use a non-current dump for realistic test)
SAMPLE=$(ls ~/.local/state/ophis/pg-backups/op-*.pgdump | shuf -n 1)
docker cp "$SAMPLE" optimism-mainnet-db-1:/tmp/
docker exec -u postgres optimism-mainnet-db-1 \
  pg_restore -d ophis_restore_test -U ophis /tmp/$(basename "$SAMPLE")

# Verify schema came through
docker exec -u postgres optimism-mainnet-db-1 \
  psql -d ophis_restore_test -U ophis -c '\dt'   # list tables

# Cleanup
docker exec -u postgres optimism-mainnet-db-1 dropdb -U ophis ophis_restore_test
```

If the restore-test fails on a dump that was supposed to be valid, the backup chain is broken — investigate before relying on it for DR.

## Observability (TODO — not yet implemented)

Currently the only signal that backup is succeeding is the local log file. **A real prod posture would**:

- Push a heartbeat metric to Prometheus on successful backup
- Alert if no successful backup in >36h
- Email/Telegram alert on restore-test failure

Tracked as part of the OP eRPC alerts PR (separate task) — that PR will add a generic Alertmanager Telegram route the backup script can also use.
