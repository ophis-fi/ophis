# Disaster recovery runbook — Mac mini SPOF mitigation

**Audience:** operator (Clement; any successor) responding to a Mac mini failure event.
**Last updated:** 2026-05-20 (long-tail 6.x).
**Related:**
- `docs/operations/founder-bus-factor.private.md` — strategy + addresses + decision authority
- `docs/operations/submitter-pk-backup-runbook.md` — PK restore (Section 5.1 in bus-factor)
- `docs/operations/op-erpc-runbook.md` — RPC layer ops
- `docs/architecture/2026-05-18-submitter-pk-custody-adr.md` — key custody choices

## What "disaster" covers

The Mac mini at Clement's Luxembourg apartment runs the entire OP mainnet Ophis stack. This runbook covers recovery for events that take it offline:

1. **Hardware failure** — SSD death, PSU, fans, motherboard. Mini is unrecoverable in-place.
2. **Physical loss** — theft, fire, flood, prolonged power outage > 4h, building access loss.
3. **OS corruption** — APFS damage, FileVault key loss, irrecoverable boot.
4. **Network partition** — Cloudflare Tunnel down, Tailscale broken, ISP outage > 1h.

Software-level outages (a service crash-loops, eRPC consensus stuck, etc.) are covered by `docs/operations/op-erpc-runbook.md` and per-service runbooks, NOT here.

## Recovery time objective (RTO)

Aspirational, not committed:

| Scenario | RTO target | Reality today |
|---|---|---|
| Service-level outage | < 15 min | Achievable (restart, redeploy) |
| Mac mini hardware failure | < 4 hours | Requires manual replacement host + restore |
| Mac mini physical loss | < 24 hours | Limited by Mac availability + offsite backup retrieval |
| Total loss + key compromise | < 72 hours | EOA rotation + Safe-signer coordination |

## Pre-disaster: what MUST be off-site

Captured in `docs/operations/submitter-pk-backup-runbook.md` and bus-factor §5. If any of these are missing TODAY, the disaster recovery procedure below does NOT work:

- [ ] **Submitter PK** on encrypted USB stick at a separate physical location. USB passphrase known to ≥2 trusted parties OR in a sealed envelope in a separate location.
- [ ] **Postgres dumps** — daily `pg_dump` of OP mainnet orderbook DB pushed to Backblaze B2 / S3 / equivalent, with ≥30 day retention. (Cron + script exist in `infra/shared/cron/postgres-backup.sh` — verify it's actually running.)
- [ ] **Ledger seed phrases** — 3 Ledgers' seeds, each independently stored. Bus-factor doc §5.3.
- [ ] **`.env` files** for `infra/optimism-mainnet/.env` — OKX credentials + CoinGecko key + Postgres password. Same USB stick OR separate encrypted backup. **NEVER in cloud storage.**

## Recovery procedure: hardware failure (in-place)

If the Mac mini is broken but you have its SSD (e.g. logic-board failure with intact storage):

1. **Pull the SSD** if possible (Mac mini SSDs are integrated post-2018, so this may not be possible — Apple Configurator restore may be the only option).
2. **Acquire replacement Mac mini** (any M-series, ≥16GB RAM, ≥512GB SSD — the OP stack uses ~10GB).
3. **Restore from Time Machine** — if Time Machine backups exist (recommended setup), this restores most of the OS, settings, and code state.
4. **Migrate ophis-driver user** — the `/Users/ophis-driver/` account with the PK file. Time Machine should restore this; if not, run the PK backup runbook restore procedure (Section "Restore" in `submitter-pk-backup-runbook.md`).
5. **Re-deploy stack** — `cd ~/greg/infra/optimism-mainnet && ./render-configs.sh && docker compose up -d --build`. The driver healthcheck (PR #132) will fail-loop until `submitter.key` is present with min-balance.

**Expected total time**: 2–4 hours assuming replacement Mac mini already on-hand.

## Recovery procedure: total loss + bring-up on alternate hardware

The Mac mini and any local backups are gone. You're restoring on a Linux box / new Mac / cloud VM.

### Step 0 — secure the EOA

The submitter PK may or may not have been compromised in the loss event. **Assume compromised** unless you have proof otherwise:

- If a thief got the encrypted USB + figured out the passphrase: PK is compromised.
- If the Mac was unencrypted at rest (FileVault off): assume PK is compromised.
- If you only lost the live machine but offsite backup is intact and air-gapped: PK is likely NOT compromised.

**If compromised:** before any other recovery step, follow `docs/operations/founder-bus-factor.private.md` §4.2 (Rotate the submitter EOA). The driver allowlist EOA on `GPv2AllowListAuthentication` must be swapped via Safe multisig vote BEFORE you restore the old PK anywhere. While the vote is pending, the protocol cannot settle — this is the right state to be in.

### Step 1 — provision replacement host

Minimum requirements:
- Docker / Docker Desktop / colima
- 16 GB RAM, 100 GB disk
- Stable internet (≥10 Mbps up; LE certs + RPC fan-out)
- macOS / Linux. Windows works with WSL but not recommended.

For an emergency cloud option (LATER MOVE BACK to physical):
- Hetzner Cloud CX31 (~€10/mo) or similar
- Caveat: cloud provider sees the rendered driver.toml = Tier 1 PK isolation is degraded. ACCEPT this for the bring-up window, plan to move back to physical or Tier 2 KMS within 7 days.

### Step 2 — restore the code

```bash
git clone https://github.com/ophis-fi/ophis ~/greg
cd ~/greg
git checkout main
```

### Step 3 — restore the ophis-driver user (if you used Tier 1)

This step assumes you have the encrypted USB with `submitter.key.CURRENT` retrieved from offsite.

```bash
sudo dscl . -create /Users/ophis-driver
sudo dscl . -create /Users/ophis-driver UserShell /usr/bin/false
sudo dscl . -create /Users/ophis-driver RealName "Ophis Driver"
sudo dscl . -create /Users/ophis-driver UniqueID "550"   # check unused
sudo dscl . -create /Users/ophis-driver PrimaryGroupID 20
sudo dscl . -create /Users/ophis-driver NFSHomeDirectory /Users/ophis-driver
sudo mkdir -p /Users/ophis-driver/.config
sudo chown -R ophis-driver:staff /Users/ophis-driver
sudo chmod 700 /Users/ophis-driver
sudo chmod 700 /Users/ophis-driver/.config

# Restore the PK from offsite USB (follow submitter-pk-backup-runbook.md Restore section)
USB_VOL=/Volumes/OPHIS-PK-BACKUP
sudo install -m 600 -o ophis-driver -g staff \
  "$USB_VOL/submitter.key.CURRENT" \
  /Users/ophis-driver/.config/submitter.key

# Verify
sudo cat /Users/ophis-driver/.config/submitter.key | grep -qE '^0x[a-fA-F0-9]{64}$' && echo OK
```

On Linux, replace `dscl` with `useradd -r -s /usr/sbin/nologin -d /home/ophis-driver -m ophis-driver`.

### Step 4 — restore .env files

```bash
USB_VOL=/Volumes/OPHIS-PK-BACKUP
cp "$USB_VOL/infra-op-env.tar.gz" /tmp/
tar -xzf /tmp/infra-op-env.tar.gz -C ~/greg/infra/optimism-mainnet/
chmod 600 ~/greg/infra/optimism-mainnet/.env
```

(The `infra-op-env.tar.gz` should contain just the `.env` file — created during the PK backup procedure. If you don't have this, you'll need to manually recreate from OKX dashboard / CoinGecko dashboard / generate a new Postgres password.)

### Step 5 — restore Postgres dump (optional but recommended)

Without restoring the dump, the orderbook starts fresh with no historical orders/quotes. This loses ~30 days of metric continuity but doesn't affect on-chain settlement integrity.

```bash
# Boot the stack with empty Postgres
cd ~/greg/infra/optimism-mainnet
./render-configs.sh
docker compose up -d db

# Wait for db healthy
docker compose wait db

# Restore from offsite backup (Backblaze B2 example)
LATEST=$(b2 ls --json ophis-backups/ | jq -r 'sort_by(.uploadTimestamp) | reverse | .[0].fileName')
b2 download-file-by-name ophis-backups "$LATEST" /tmp/restore.pgdump
docker cp /tmp/restore.pgdump optimism-mainnet-db-1:/tmp/
docker exec -u postgres optimism-mainnet-db-1 \
  pg_restore -d ophis -U ophis --clean --if-exists /tmp/restore.pgdump

# Then bring up the rest of the stack
docker compose up -d --build
```

### Step 6 — verify health

```bash
# All containers healthy
docker compose ps

# eRPC consensus succeeding
curl -s http://127.0.0.1:4001/metrics | grep -E 'erpc_consensus_total{.*outcome="success"' | head -5

# Driver healthcheck returning 200
docker inspect optimism-mainnet-driver-1 --format '{{.State.Health.Status}}'   # expect "healthy"

# Autopilot finding orders
docker logs --tail 50 optimism-mainnet-autopilot-1 | grep -i "run_id\|solve\|auction"
```

If any of these fail, **STOP** and consult the relevant per-service runbook before broadcasting any settlement.

### Step 7 — update DNS + Cloudflare Tunnel (if changing host)

If the bring-up is on different infrastructure, the `https://ophis.fi` frontend's API routes (CF Tunnel) need re-pointing:

- Update CF Tunnel origin in the Cloudflare dashboard
- Verify `https://ophis.fi/api/v1/...` resolves to the new host

CF Tunnel runs as a launchd agent on the Mac mini today; the equivalent on Linux is the `cloudflared` systemd unit.

### Step 8 — post-recovery checklist

- [ ] All containers healthy for 30 minutes
- [ ] At least one settlement broadcast successfully (or, on Sunday low-volume, at least one quote successfully returned via `/api/v1/quote`)
- [ ] Backup procedures re-armed (PK USB plugged back in offsite location; pg_dump cron restored)
- [ ] If on cloud emergency host: plan move-back to physical within 7 days
- [ ] If EOA rotated in Step 0: confirm new EOA is allowlisted via on-chain `addSolver` event
- [ ] Update `docs/operations/founder-bus-factor.private.md` with the post-incident reality (new host, new EOA, what was lost, what was preserved)

## What this runbook does NOT cover

- Recovery from a Safe-signer compromise (multisig governance). Separate playbook needed; coordinate with the other Safe signers.
- Recovery from a smart-contract exploit that drained the protocol Safe. That's a Safe-multisig + on-chain remediation problem, not a host-recovery problem.
- Long-running migration to high-availability (multi-region active-active). Tracked as separate roadmap work; this runbook assumes single-host operation indefinitely.

## What's MISSING that should exist

Real audit-level prod readiness asks for:

1. **Live secondary host** (warm or hot) — currently NONE. Single Mac mini.
2. **Automated daily restore test** — partial. `docs/operations/postgres-backup-setup.md` documents the verification procedure but it's not yet a recurring task.
3. **Documented RPO** (recovery point objective) — currently ad-hoc; daily Postgres dump = up to 24h of orderbook state loss in worst case.
4. **PagerDuty / Telegram alerting on healthcheck-fail** — Telegram exists for HL eRPC alerts (paused stack); OP equivalent shipped in PR #142 + #154.

Each of these is a separate roadmap item. Recovery without them is possible (this runbook IS the recovery) but takes longer than it should.

## DR drill 2026-05-20 — findings

First end-to-end drill (Phase 2.1) executed on Aleph VM `ophis-rebates-vm`
(`45.144.209.26:24014`) using the Mac mini's nightly Postgres dump
shipped via Tailscale. Outcome:

**Passed:**

- `rsync` of dump file over Tailscale: 65572 bytes in <1s
- `git clone` of repo into a fresh dir
- Scratch `postgres:16` container spun up
- `pg_restore` of dump into scratch container: clean exit, no errors
- Schema verification: **31 tables** restored in public schema
  (auctions, auction_orders, fee_policies, ethflow_orders,
  last_indexed_blocks, order_events, etc.). All expected CoW tables
  present.

**Gaps discovered (must fix before a full DR-on-Linux drill works):**

### G1 — render-configs.sh hardcodes macOS path `/Users/ophis-driver/.config/submitter.key`

A Linux DR target uses `/home/ophis-driver/.config/...` (not `/Users/`).
The script's `sudo cat /Users/ophis-driver/...` would fail on a fresh
Linux box. Fix: thread the path through `${OPHIS_SUBMITTER_KEY_PATH:-...}`
with a Mac default; document the Linux override in this runbook.

### G2 — Tier 1.5 RAM-disk uses macOS `hdiutil`

`render-configs.sh:mount_ram_disk()` calls `hdiutil attach ram://...`
+ `newfs_hfs` — both macOS-only. On Linux DR target, the equivalent
is `mount -t tmpfs tmpfs $RAM_PK_MOUNT -o size=1M,mode=0700`. The script
should detect platform and branch (or have a Linux-specific variant
in the runbook).

### G3 — ✅ FIXED (PR #164): `scripts/setup-ophis-driver-user.sh`

Idempotent dual-platform script. Branches on `uname -s`. macOS uses
`dscl` to create the user; Linux uses `useradd --system --no-create-home
--shell /usr/sbin/nologin`. Both create the home dir + .config subdir
at chmod 700. After running it, install the PK file via:

```bash
echo '0x<64-hex-pk>' | sudo install -m 600 -o ophis-driver -g <group> \
  /dev/stdin /<homedir>/ophis-driver/.config/submitter.key
```

### G4 — ✅ FIXED (PR #163 verification)

`compose-up.sh` had no macOS-specific bits on review. The `sed -i`
concern was inside `render-configs.sh`, which now branches on
platform for the RAM-disk + PK path. No further fixes needed.

**Status:** Phase 2.1 (Postgres restore drill) ✅. G1+G2+G3+G4 all
fixed. Phase 2.2 (full DR drill on Linux) is now unblocked — when
ready, run the drill on Aleph VM2:

1. `git clone https://github.com/ophis-fi/ophis /srv/ophis-dr/` on VM2
2. `./infra/optimism-mainnet/scripts/setup-ophis-driver-user.sh` on VM2
3. Install backup PK at `/home/ophis-driver/.config/submitter.key`
   (chmod 600 owner ophis-driver) — for a true drill this is a
   non-allowlisted dummy EOA; for actual failover it's the real PK
   restored from offsite USB
4. Restore the latest Postgres dump (Phase 2.1 procedure)
5. Set `TENDERLY_API_KEY`, `OKX_*`, `COINGECKO_API_KEY` in `.env`
6. Set `OPHIS_SUBMITTER_KEY_PATH=/home/ophis-driver/.config/submitter.key`
   in `.env` (G1 portability)
7. `./compose-up.sh` — picks up Linux tmpfs RAM-disk + Linux PK path
8. Verify health, document any new gaps
