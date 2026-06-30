#!/usr/bin/env bash
# Ophis Unichain mainnet — render *.toml.tmpl into ./rendered/*.toml.
#
# The CoW solver TOML parser doesn't substitute env vars at parse time, so
# we pre-render TOML templates that need secrets (OKX, driver-submitter PK).
#
# ## Tier 1 PK isolation (2026-05-18, scope-honest 2026-05-19)
#
# **What Tier 1 actually achieves today:**
#   - PK source-of-truth is the file at /Users/ophis-driver/.config/submitter.key
#     (mode 0600, owner ophis-driver), NOT a .env entry that other processes
#     running as scep could read.
#   - The script refuses to run if .env still contains the legacy
#     OPHIS_DRIVER_SUBMITTER_KEY line.
#   - Read requires sudo, which is YubiKey-gated when MFA is configured.
#
# **What Tier 1 DOES NOT achieve (Phase 4 audit H1, 2026-05-19):**
#   - The rendered driver.toml STILL lives at ./rendered/driver.toml under
#     scep's home directory (mode 0600 owner=scep). Any process running as
#     scep can read it. This is NOT "isolation from scep"; it's "isolation
#     from random other-user processes" (of which the Mac mini has none in
#     practice).
#
# **Why we can't fix this in Tier 1:**
#   - colima's virtiofs daemon runs as scep and can ONLY bind-mount paths
#     scep can read. Moving the rendered driver.toml to
#     /Users/ophis-driver/rendered/... would break the docker bind mount
#     (verified: docker-compose.yml driver volume mount is
#     ./rendered/driver.toml:/driver.toml:ro).
#
# **Upgrade paths from here:**
#   1. Tier 1.5 (in-RAM): render driver.toml to a hdiutil-managed RAM disk
#      that's bind-mounted into the container. Avoids on-disk PK exposure.
#      ~Half-day of work; tracked as a follow-up.
#   2. Tier 2 (KMS, $140/yr AWS): the driver's Account::Kms code path
#      already exists. Eliminates local PK exposure entirely. Tracked as
#      roadmap task 1.9.
#   3. Switch off colima (Rancher Desktop / Docker Desktop) to enable
#      cross-user bind mounts. ~1-2h migration; risks breaking other dev
#      workflows.
#
# Run before `docker compose up`. Run from this directory.
#
# ## Caveats not enforced by this script
#
#   - If `/etc/sudoers` has `Defaults log_input`, the PK is written to
#     `/var/log/sudo-io/` when sudo prompts on TTY. Check + remove that
#     directive before relying on Tier 1 (sharp-edges note).
#   - Tier 1 protects against random scep-process exfiltration. Same-UID
#     processes (e.g. shared systemd User= accounts) bypass it; the Mac
#     mini doesn't have any such today.
#
# ## Exit codes
#   1 — .env missing
#   2 — running under set -x (PK would leak in trace)
#   4 — .env still has legacy OPHIS_DRIVER_SUBMITTER_KEY line
#   5 — PK file at /Users/ophis-driver/.config/submitter.key is malformed

set -euo pipefail
# Defense-in-depth (Phase 4 audit H2): tighten umask BEFORE any file
# operations so the brief window between `envsubst > out` and `chmod 600`
# can't be opened by another process. Without this, the default macOS
# umask (022) leaves a microsecond-scale 0644 window per template.
umask 077

# Refuse to run under `set -x` / `bash -x` (sharp-edges audit pattern,
# mirroring HL render-configs.sh:18-25): the sudo cat below traces the
# PK if -x is set.
if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: the PK would leak in the trace." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Preflight: scan configs/*.toml (non-tmpl) for placeholder syntax. A6
# whole-repo audit H1 (2026-05-21): the Tier-1→1.5 migration left
# `configs/driver.toml` (pre-Tier-1 rendered output with literal
# %OPHIS_DRIVER_SUBMITTER_KEY placeholders) git-tracked next to its
# .tmpl. If docker-compose's bind-mount path ever drifts back to that
# location, the driver would start with a placeholder-laden config.
# Fail-closed here on any non-tmpl config that contains placeholder
# syntax — they should either be canonical (no placeholders) or
# rendered (to ./rendered/), never both.
#
# Only `${var}` style placeholders are checked. The legacy `%var` style
# (from CoW's earlier substitution format) is also rejected.
stale_with_placeholder=()
shopt -s nullglob
for cfg in configs/*.toml configs/*.yaml; do
  # Skip if a .tmpl version doesn't exist — then this `cfg` is the
  # canonical hand-edited config (e.g. autopilot.toml has no .tmpl
  # because it has no secrets to substitute).
  [[ ! -f "${cfg}.tmpl" ]] && continue
  if grep -qE '%[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\}' "$cfg" 2>/dev/null; then
    stale_with_placeholder+=("$cfg")
  fi
done
shopt -u nullglob
if (( ${#stale_with_placeholder[@]} > 0 )); then
  echo "" >&2
  echo "ERROR: stale config(s) with placeholder syntax detected next to .tmpl files:" >&2
  for f in "${stale_with_placeholder[@]}"; do echo "  - $f" >&2; done
  echo "" >&2
  echo "  These look like leftover rendered output from a prior render-configs.sh" >&2
  echo "  run that didn't clean up. The canonical path is:" >&2
  echo "    - secret-bearing render → ./rendered/$cfg (NOT configs/)" >&2
  echo "    - non-secret canonical  → keep ONLY configs/<name>.toml, delete .tmpl" >&2
  echo "  Decide which, delete the wrong one, and re-run." >&2
  exit 13
fi

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $SCRIPT_DIR — copy from .env.example first" >&2
  exit 1
fi

# Tier 1 PK isolation: refuse to render if .env sets a NON-EMPTY PK value.
# (Env-var precedence from `source .env` would mask the ophis-driver file.)
# An empty `OPHIS_DRIVER_SUBMITTER_KEY=` line — as shipped in .env.example with
# "LEAVE EMPTY here" — is harmless: `source` sets it to "" and the sudo-cat
# below overwrites it from the key file. Matching only a populated value keeps
# the sample .env copy-paste-renderable (Codex #718 P2).
if grep -qE "^[[:space:]]*OPHIS_DRIVER_SUBMITTER_KEY=[^[:space:]]" .env; then
  echo "ERROR: .env sets a non-empty OPHIS_DRIVER_SUBMITTER_KEY — remove the value." >&2
  echo "       Tier 1 moved the PK source to /Users/ophis-driver/.config/submitter.key;" >&2
  echo "       an inline value here would override it. Leave the line empty or delete it." >&2
  exit 4
fi

# Refuse to render if .env still has another stack's bypass var name. This stack
# is a COPY of the Base scaffold, so a leftover BASE_RPC_INTERNAL must hard-fail
# here — otherwise it is silently ignored (fail-OPEN) since the active var is now
# UNICHAIN_RPC_INTERNAL. OP_RPC_INTERNAL is likewise rejected.
if grep -qE "^[[:space:]]*(OP_RPC_INTERNAL|BASE_RPC_INTERNAL)=" .env; then
  echo "ERROR: .env contains OP_RPC_INTERNAL/BASE_RPC_INTERNAL — this is the Unichain mainnet stack." >&2
  echo "       Use UNICHAIN_RPC_INTERNAL for the Unichain bypass guard." >&2
  exit 4
fi

# Tighten .env perms BEFORE reading it (sharp-edges MED-3, pre-PR
# review): chmod 600 after `source` would leave the file world-readable
# during the read window. Idempotent — chmod is a no-op if already 600.
chmod 600 .env

# Load .env into this shell so envsubst sees the non-PK vars (OP_MAINNET_RPC,
# OKX_*). After Tier 1, .env has NO PK and source can't re-introduce it.
set -a
# shellcheck disable=SC1091
source .env
set +a

# Resolve PK file path.
#
# G1 portability (2026-05-20 DR drill findings): on macOS the canonical
# location is /Users/ophis-driver/.config/submitter.key (legacy Mac
# home convention). On Linux DR target, the equivalent is
# /home/ophis-driver/.config/submitter.key. Both are honored; operator
# can override explicitly via OPHIS_SUBMITTER_KEY_PATH if the user
# layout differs.
if [[ -z "${OPHIS_SUBMITTER_KEY_PATH:-}" ]]; then
  case "$(uname -s)" in
    Darwin) OPHIS_SUBMITTER_KEY_PATH="/Users/ophis-driver/.config/submitter.key" ;;
    Linux)  OPHIS_SUBMITTER_KEY_PATH="/home/ophis-driver/.config/submitter.key" ;;
    *)      echo "ERROR: unsupported platform $(uname -s). Set OPHIS_SUBMITTER_KEY_PATH explicitly." >&2; exit 5 ;;
  esac
fi

# Read PK from ophis-driver-owned file via sudo (need root to bypass 0700 home).
OPHIS_DRIVER_SUBMITTER_KEY=$(sudo cat "$OPHIS_SUBMITTER_KEY_PATH" 2>/dev/null | tr -d '\n\r')
if [[ ! "$OPHIS_DRIVER_SUBMITTER_KEY" =~ ^0x[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: PK from $OPHIS_SUBMITTER_KEY_PATH not a 32-byte hex." >&2
  echo "       Run ./infra/tier1-pk-isolation-setup.sh first," >&2
  echo "       OR if this is a DR-target machine, set up the ophis-driver" >&2
  echo "       user and PK file per docs/operations/disaster-recovery-runbook.md." >&2
  exit 5
fi
export OPHIS_DRIVER_SUBMITTER_KEY

mkdir -p rendered
shopt -s nullglob

# ── Tier 1.5 RAM-disk PK render (Phase 4 audit H1 follow-up, 2026-05-20) ──
#
# The rendered driver.toml has the submitter PK substituted in-line. Pre-
# Tier-1.5 that file lived at ./rendered/driver.toml under scep's home —
# meaning any process running as scep could read it (defeats Tier 1
# isolation), AND the file persisted on the FileVault-encrypted SSD where
# Time Machine could back it up, Spotlight could index it, APFS journal
# could retain copy-on-write snapshots.
#
# Tier 1.5 writes driver.toml to a hdiutil-managed RAM-backed HFS+ volume
# at $HOME/.local/state/ophis/ram-pk/. ./rendered/driver.toml becomes a
# symlink pointing into the RAM-disk. docker-compose's bind-mount
# (./rendered/driver.toml:/driver.toml:ro) follows the symlink through
# colima's virtiofs.
#
# What this closes:
#   - No persistent SSD trace (RAM-disk wipes on reboot/poweroff)
#   - No Time Machine inclusion (TM ignores /dev/disk* ramdisks)
#   - No Spotlight index (volumes under $HOME without user-content are skipped)
#   - Forensic recovery after `rm` impossible (RAM, not APFS journal)
#
# What this does NOT close:
#   - Same-UID exfiltration. Any process as `scep` can still `cat` the file.
#     Closing that requires Tier 2 KMS (no local PK at all).
#   - Process-tracing of render-configs.sh during the envsubst window
#     (handled by the `set -x` refuse at the script top).
#   - The OPERATOR running `cat`/`grep` on the rendered file. Don't do that.
#     See [[feedback-never-grep-pk-from-rendered-configs]].
#
# Cold-start dependency: RAM-disk dies on reboot. ./render-configs.sh
# re-mounts it idempotently. If render-configs.sh has NOT been run since
# boot, the symlink dangles and docker compose up fails on bind-mount.
# Docs/runbook captures this in operational guidance.

RAM_PK_MOUNT="$HOME/.local/state/ophis/ram-pk"
RAM_PK_VOLNAME="ophis-ram-pk"
RAM_PK_SIZE_SECTORS=2048   # 2048 * 512B = 1 MB

# Idempotent mount. Exits non-zero on failure — we WANT this to hard-fail
# rather than fall through to writing the PK on disk.
#
# Pre-merge audit (sharp-edges BLOCKER-1 + Codex HIGH): the prior version
# trusted "anything mounted at $RAM_PK_MOUNT" as the RAM-disk. If the
# operator (or a malicious local actor) pre-mounted some other volume
# at that path, the script would happily write the PK to it. The new
# version verifies the mounted volume is RAM-backed via `diskutil info`,
# and aborts if not.
mount_ram_disk() {
  case "$(uname -s)" in
    Darwin) _mount_ram_disk_macos ;;
    Linux)  _mount_ram_disk_linux ;;
    *)      echo "ERROR: unsupported platform $(uname -s) for RAM-disk mount" >&2; return 1 ;;
  esac
}

# Linux variant — uses tmpfs (kernel-resident pages, no disk).
# G2 portability fix (2026-05-20 DR drill findings).
_mount_ram_disk_linux() {
  if mount | grep -qE " ${RAM_PK_MOUNT} type tmpfs"; then
    # Existing tmpfs mount — verify marker file presence.
    local marker="${RAM_PK_MOUNT}/.ophis-ram-pk-marker"
    if [[ ! -f "$marker" ]] || ! grep -qFx "$RAM_PK_VOLNAME" "$marker" 2>/dev/null; then
      echo "ERROR: $RAM_PK_MOUNT mounted but marker file missing/wrong." >&2
      echo "       To recover: sudo umount $RAM_PK_MOUNT && re-run." >&2
      return 1
    fi
    return 0  # confirmed: our tmpfs
  fi
  mkdir -p "$RAM_PK_MOUNT"
  # 1 MB tmpfs, mode 0700, mounted by current user (uid/gid via -o).
  if ! sudo mount -t tmpfs tmpfs "$RAM_PK_MOUNT" \
       -o "size=1M,mode=0700,uid=$(id -u),gid=$(id -g)"; then
    echo "ERROR: tmpfs mount at $RAM_PK_MOUNT failed (need passwordless sudo for `mount`)" >&2
    return 1
  fi
  # Write marker file (now writable since we own the mount).
  local marker="${RAM_PK_MOUNT}/.ophis-ram-pk-marker"
  printf '%s\n' "$RAM_PK_VOLNAME" > "$marker"
  chmod 600 "$marker"
  echo "  mounted RAM-disk at $RAM_PK_MOUNT (tmpfs, 1 MB, marker=$RAM_PK_VOLNAME)"
}

# macOS variant — uses hdiutil + newfs_hfs (RAM-backed HFS+ volume).
# Existing-mount check uses a marker file inside the volume rather
# than diskutil's volume name (newfs_hfs labels are invisible to
# diskutil for ram-disks). See sharp-edges audit history in PR #147.
_mount_ram_disk_macos() {
  if mount | grep -Fq " on ${RAM_PK_MOUNT} ("; then
    local existing_dev
    existing_dev=$(mount | grep -F " on ${RAM_PK_MOUNT} (" | awk '{print $1}')
    if [[ ! "$existing_dev" =~ ^/dev/disk[0-9]+ ]]; then
      echo "ERROR: $RAM_PK_MOUNT mounted but device '$existing_dev' isn't /dev/disk*" >&2
      return 1
    fi
    local marker="${RAM_PK_MOUNT}/.ophis-ram-pk-marker"
    if [[ ! -f "$marker" ]] || ! grep -qFx "$RAM_PK_VOLNAME" "$marker" 2>/dev/null; then
      echo "ERROR: $RAM_PK_MOUNT mounted but marker file missing/wrong." >&2
      echo "       To recover: stop the driver container, then:" >&2
      echo "         sudo umount -f $RAM_PK_MOUNT && hdiutil detach ${existing_dev} -force" >&2
      return 1
    fi
    return 0  # confirmed: our RAM-disk
  fi
  mkdir -p "$RAM_PK_MOUNT"

  local dev
  dev=$(hdiutil attach -nomount "ram://${RAM_PK_SIZE_SECTORS}" | awk 'NR==1 {print $1}')
  if [[ ! "$dev" =~ ^/dev/disk[0-9]+$ ]]; then
    echo "ERROR: hdiutil attach returned unexpected first-line device: '$dev'" >&2
    return 1
  fi

  if ! newfs_hfs -v "$RAM_PK_VOLNAME" "$dev" >/dev/null 2>&1; then
    echo "ERROR: newfs_hfs failed on $dev" >&2
    hdiutil detach "$dev" >/dev/null 2>&1 || true
    return 1
  fi

  if ! mount -t hfs "$dev" "$RAM_PK_MOUNT"; then
    echo "ERROR: mount -t hfs $dev $RAM_PK_MOUNT failed" >&2
    hdiutil detach "$dev" >/dev/null 2>&1 || true
    return 1
  fi
  chmod 700 "$RAM_PK_MOUNT"

  local marker="${RAM_PK_MOUNT}/.ophis-ram-pk-marker"
  printf '%s\n' "$RAM_PK_VOLNAME" > "$marker"
  chmod 600 "$marker"

  # Adversarial-modeler A8 (2026-05-20): disable Spotlight indexing on
  # the RAM-disk. By default macOS may attempt to index files under
  # any HFS+ volume; even though our mount is under $HOME without
  # user-content metadata, `mdfind` could surface the rendered PK via
  # the Spotlight cache. `mdutil -i off` disables indexing for this
  # specific volume. Best-effort (|| true) — older macOS versions
  # ignore the call cleanly.
  mdutil -i off "$RAM_PK_MOUNT" >/dev/null 2>&1 || true

  echo "  mounted RAM-disk at $RAM_PK_MOUNT (device $dev, 1 MB, HFS+, volname=$RAM_PK_VOLNAME)"
}

# Resolve TELEGRAM_BOT_TOKEN — preferred source is macOS Keychain
# (Phase 1.5, 2026-05-20). Keeps the token out of .env cleartext and
# off Time Machine / Spotlight / casual `cat .env` exposure.
#
# Lookup order (first match wins):
#   1. env var TELEGRAM_BOT_TOKEN (set explicitly in the shell, or in
#      .env — supported for backwards-compat, but discouraged)
#   2. macOS Keychain entry:
#        service=ophis-telegram-bot, account=$USER, kind=generic-password
#
# Setup (one-time):
#   security add-generic-password -a "$USER" -s ophis-telegram-bot \
#     -w '<bot-token>' -U
#
# The -U flag updates if the entry already exists (idempotent).
# Once added, the token persists across .env regenerations + reboots.
if [[ -d observability && -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  if security find-generic-password -a "$USER" -s ophis-telegram-bot -w >/dev/null 2>&1; then
    TELEGRAM_BOT_TOKEN=$(security find-generic-password -a "$USER" -s ophis-telegram-bot -w 2>/dev/null)
    export TELEGRAM_BOT_TOKEN
    echo "  resolved TELEGRAM_BOT_TOKEN from Keychain (service=ophis-telegram-bot)"
  fi
fi

# Validate TELEGRAM_BOT_TOKEN shape. Match: `{int}:{base64-ish-suffix}`
# per Telegram bot token convention. A typo means alerts silently
# disappear into a 404 → defeats observability.
if [[ -d observability && -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  if [[ ! "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN doesn't look like a Telegram bot token ({int}:{base64-ish})" >&2
    echo "       Source: $([ -n "${TELEGRAM_BOT_TOKEN_FROM_KEYCHAIN:-}" ] && echo Keychain || echo env-var)" >&2
    exit 2
  fi
fi

if ! mount_ram_disk; then
  echo "FATAL: could not mount RAM-disk for PK-bearing config. Refusing to" >&2
  echo "       fall through to disk-write of driver.toml. Investigate:" >&2
  echo "       - hdiutil + diskutil available?" >&2
  echo "       - \$HOME/.local/state/ophis/ram-pk writable?" >&2
  echo "       - existing stale mount? (mount | grep ophis-ram-pk; diskutil unmount ...)" >&2
  exit 6
fi

# Codex retro-audit (2026-05-20, MED-2): OP_RPC_INTERNAL is a one-env-var
# downgrade from 3-of-3 consensus to single-provider — a forged answer
# from a single upstream becomes settlement-authoritative. Sharp-edges
# previously asked for a warning; that's not enough because
# `docker compose up` skips render-configs.sh entirely. Now we require
# an explicit ACK env var so a forgotten dev value can't silently
# downgrade production.
if [[ -n "${UNICHAIN_RPC_INTERNAL:-}" ]]; then
  if [[ "${ALLOW_RPC_BYPASS:-}" != "1" ]]; then
    echo "" >&2
    echo "*** REFUSING: UNICHAIN_RPC_INTERNAL is set in .env ***" >&2
    echo "    Value: ${UNICHAIN_RPC_INTERNAL}" >&2
    echo "    This BYPASSES the eRPC 2-of-3 consensus path and downgrades" >&2
    echo "    the stack to single-provider posture. A single hostile" >&2
    echo "    upstream can poison reads under this configuration." >&2
    echo "" >&2
    echo "    If this is intentional (failure-domain test / emergency):" >&2
    echo "      ALLOW_RPC_BYPASS=1 ./render-configs.sh" >&2
    echo "" >&2
    echo "    Otherwise: remove or empty the UNICHAIN_RPC_INTERNAL line from .env." >&2
    exit 12
  fi
  echo "" >&2
  echo "*** WARNING: UNICHAIN_RPC_INTERNAL is set + ALLOW_RPC_BYPASS=1 ***" >&2
  echo "    Operating in single-provider bypass mode. Consensus disabled." >&2
  echo "    Value: ${UNICHAIN_RPC_INTERNAL}" >&2
  echo "" >&2
fi

# Templates that contain substituted SECRETS (after envsubst) MUST land
# on the RAM-disk; everything else stays in ./rendered/ on disk. The
# canonical list — covers both the submitter PK and the OKX
# credentials (api-key + secret-key + passphrase). The post-render
# assertion below scans all non-PK_BEARING files for both PK and
# OKX-shaped secret literals, so a future template-edit that adds a
# secret-substitution to a non-listed file will fail-closed before the
# stack starts.
# baseline, orderbook, autopilot, kyberswap, velora now all use .tmpl
# (UNICHAIN_RPC_INTERNAL must thread through). driver.toml (PK), okx.toml (OKX
# secrets) and odos.toml (Odos x-api-key) bear secrets and must land on the
# RAM-disk.
PK_BEARING_NAMES=(driver.toml okx.toml odos.toml)

is_pk_bearing() {
  local n="$1"
  local p
  for p in "${PK_BEARING_NAMES[@]}"; do
    if [[ "$n" == "$p" ]]; then return 0; fi
  done
  return 1
}

# Refuse to render while any WS3 contract / WS10 submitter fill-in placeholder is
# still present in the SOURCE templates. They must be filled (see
# FILL-IN-AFTER-DEPLOY.md) before the stack can run; rendering through them only
# defers the failure to config-parse time (invalid address). Checked on the .tmpl
# source, which is PK-free — NEVER grep the rendered driver.toml, which carries
# the submitter PK (feedback-never-grep-pk-from-rendered-configs).
unfilled=()
for tmpl in configs/*.toml.tmpl configs/*.yaml.tmpl; do
  [[ -f "$tmpl" ]] || continue
  if grep -qE '__FILL_AFTER_DEPLOY_[A-Z]+__' "$tmpl"; then
    unfilled+=("$tmpl")
  fi
done
if (( ${#unfilled[@]} > 0 )); then
  echo "ERROR: unfilled __FILL_AFTER_DEPLOY_*__ placeholders remain in:" >&2
  printf '  %s\n' "${unfilled[@]}" >&2
  echo "Fill all WS3 contract + WS10 submitter placeholders before rendering (see FILL-IN-AFTER-DEPLOY.md)." >&2
  exit 1
fi

for tmpl in configs/*.toml.tmpl configs/*.yaml.tmpl; do
  # `shopt -s nullglob` (set above) makes the globs return nothing when
  # there are no matches, so this loop is safe even if only one extension
  # is present.
  name="$(basename "$tmpl" .tmpl)"

  if is_pk_bearing "$name"; then
    # PK-bearing → write to RAM-disk, symlink ./rendered/$name → RAM-disk path.
    # The symlink keeps docker-compose's existing bind-mount source
    # (./rendered/driver.toml) working unchanged.
    out="${RAM_PK_MOUNT}/${name}"
    out_tmp="${out}.tmp.$$"
    rm -f "rendered/${name}"  # clear any prior on-disk render (Tier 1 → 1.5 migration)
    ln -sf "$out" "rendered/${name}"
  else
    out="rendered/$name"
    out_tmp="${out}.tmp.$$"
  fi

  # Atomic-write (Codex Low): render to a temp file in the same dir, chmod,
  # then `mv` (rename within the same filesystem is atomic on macOS HFS+
  # and APFS). Without this, a concurrent `docker compose up` could read
  # an empty/partial config during the envsubst write window.
  #
  # envsubst only substitutes the explicit list we pass — keeps unknown
  # ${VARS} in eRPC's YAML syntax (none today, but defensive against
  # future eRPC config additions like ${ALCHEMY_API_KEY}).
  envsubst '${UNICHAIN_MAINNET_RPC} ${UNICHAIN_RPC_INTERNAL} ${OKX_PROJECT_ID} ${OKX_API_KEY} ${OKX_SECRET_KEY} ${OKX_PASSPHRASE} ${ODOS_API_KEY} ${OPHIS_DRIVER_SUBMITTER_KEY}' \
    < "$tmpl" > "$out_tmp"
  # PK/secret-bearing configs stay 0600. Non-secret configs (RPC URLs,
  # contract addresses, %VAR runtime-substituted placeholders — NO secret
  # literals) get 0644 so NON-ROOT container users can read them: the erpc
  # image runs as `nonroot`, and on native Linux Docker (the VM) bind-mount
  # perms are literal, so a root:0600 erpc.yaml is unreadable by erpc → a
  # "permission denied" boot loop. macOS/colima's uid mapping masked this.
  # (chmod is redundant-but-defensive under the umask 077 set at script top.)
  if is_pk_bearing "$name"; then
    chmod 600 "$out_tmp"
  else
    chmod 644 "$out_tmp"
  fi
  mv -f "$out_tmp" "$out"

  if is_pk_bearing "$name"; then
    echo "  rendered  $name  → RAM-disk ($RAM_PK_MOUNT)"
  else
    echo "  rendered  $name"
  fi
done

# Sanity: if Tier 1.5 left a stale on-disk driver.toml from a prior
# Tier-1-only render, scrub it now. We already removed it BEFORE envsubst
# above, but the rendered/.../driver.toml.BAK pattern from older operator
# scripts is worth a defense-in-depth pass.
find rendered -maxdepth 1 -name "driver.toml.BAK*" -print -exec rm -f {} \;
find rendered -maxdepth 1 -name "driver.toml.OLD*" -print -exec rm -f {} \;

# NOTE: the eRPC 2-of-3 fail-closed consensus guard (#447) is enforced at CI/PR
# time (infra/optimism-mainnet/assert-erpc-failclosed.py, run by the
# "erpc-consensus-guard" job in .github/workflows/ci.yml) — deliberately NOT
# here. Wiring PyYAML into the render path would make a stack restart fail on an
# operator/DR host without PyYAML, which is worse than the weakening it guards
# against (Codex #464 P1). Template edits go through PRs, where the guard fires.

# Post-render secret-leak assertion (sharp-edges MED-1 + Codex Medium):
# If a future template-edit introduces a secret-substitution into a
# file NOT in PK_BEARING_NAMES, the prior loop would silently write the
# secret to disk. Scan all NON-symlink files in rendered/ for both the
# 64-hex PK literal AND OKX-shaped secret literals (uuid-format api-key,
# 32-hex secret-key). Fail closed on any match.
#
# We grep for the patterns, not the values themselves, so the
# assertion check doesn't itself surface the secret in error messages.
# The find expression is parenthesized — without parens, BSD find +
# Linux find diverge on whether -maxdepth applies to both -name arms.
violating_files=()
while IFS= read -r f; do
  if [[ -n "$f" && ! -L "$f" ]]; then
    # 64-hex `"0x..."` — submitter PK pattern. EXCLUDE the UniswapV3
    # `init-code-hash` line: it is a 64-hex PUBLIC constant in the
    # native-price-estimation config (same across all chains, see
    # orderbook/autopilot.toml.tmpl) — not a secret. Without this carve-out
    # the broad scan false-positives autopilot.toml + orderbook.toml. The
    # carve-out is line-scoped (grep -v on the matched lines), so any OTHER
    # 64-hex literal in any field still trips the guard (defense-in-depth
    # preserved). The real submitter PK only ever appears as `account = "0x…"`
    # in driver.toml, which is a RAM-disk symlink and skipped by the `! -L` above.
    if grep -E '"0x[a-fA-F0-9]{64}"' "$f" 2>/dev/null | grep -qvE 'init-code-hash'; then
      violating_files+=("$f (PK literal)")
      continue
    fi
    # uuid-shaped api-key (8-4-4-4-12 hex w/ dashes) — covers BOTH the OKX
    # api-key AND the Odos x-api-key (same format). Both their templates set
    # `api-key = "${...}"`, and both okx.toml + odos.toml are in
    # PK_BEARING_NAMES (RAM-disk symlinks, skipped by `! -L`); this guard
    # fail-closes if either ever leaks into a non-RAM-disk rendered file.
    if grep -qE 'api-key = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"' "$f" 2>/dev/null; then
      violating_files+=("$f (uuid api-key: OKX or Odos)")
      continue
    fi
    # OKX secret-key: 32-char hex.
    if grep -qE 'api-secret-key = "[A-Fa-f0-9]{32}"' "$f" 2>/dev/null; then
      violating_files+=("$f (OKX api-secret-key)")
      continue
    fi
  fi
done < <(find rendered -maxdepth 1 -type f \( -name "*.toml" -o -name "*.yaml" \))

if (( ${#violating_files[@]} > 0 )); then
  echo "" >&2
  echo "FATAL: secret literal found in non-RAM-disk rendered files:" >&2
  for f in "${violating_files[@]}"; do
    echo "  - $f" >&2
  done
  echo "" >&2
  echo "  A template now substitutes a secret (\${OPHIS_DRIVER_SUBMITTER_KEY}," >&2
  echo "  \${OKX_API_KEY}, \${OKX_SECRET_KEY}, etc.) into a file that isn't in" >&2
  echo "  PK_BEARING_NAMES. Either:" >&2
  echo "    a) Add the name to PK_BEARING_NAMES so it lands on RAM-disk, OR" >&2
  echo "    b) Stop substituting the secret in that template." >&2
  echo "  Scrub the listed file(s) — they contain live secrets." >&2
  exit 7
fi

# ── Render observability/alertmanager (Telegram token) ────────────────────
# Mirrors HL stack pattern (infra/hyperevm-mainnet/render-configs.sh:140+).
# Alertmanager reads its bot token from a chmod-600 file (bot_token_file
# in YAML) rather than env-var-injected, to avoid `docker inspect` env leak.
if [[ -d observability ]]; then
  mkdir -p observability-rendered
  # On the native-Linux VM the alertmanager container runs as uid "nobody" and
  # must TRAVERSE this dir to read the (0644) alertmanager.yml + the token; umask
  # 077 would leave it 0700 (untraversable by nobody). 0711 = traverse-only.
  [[ "$(uname -s)" == "Linux" ]] && chmod 711 observability-rendered
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    # Render alertmanager.yml.tmpl → observability-rendered/alertmanager.yml
    for tmpl in observability/*.yml.tmpl; do
      name="$(basename "$tmpl" .tmpl)"
      out_tmp="observability-rendered/${name}.tmp.$$"
      envsubst '${TELEGRAM_BOT_TOKEN}' < "$tmpl" > "$out_tmp"
      # alertmanager.yml is NON-secret (token via bot_token_file, not inline), so
      # 0644 lets the alertmanager container (user "nobody") read it on the
      # native-Linux VM where root-owned 0600 files are unreadable by nobody.
      chmod 644 "$out_tmp"
      mv -f "$out_tmp" "observability-rendered/${name}"
      echo "  rendered  observability/$name"
    done
    # Token in a chmod-600 file on the RAM-disk (sharp-edges HIGH-4
    # follow-up: same persistent-storage threat model as the PK — Time
    # Machine / APFS local snapshots / Spotlight could otherwise retain
    # the bot token across rotations). A leaked bot token lets an
    # attacker DM Clement as the alert bot → phishing primitive against
    # the very operator who'd act on alerts.
    # Token perms diverge by platform. Alertmanager runs as uid 65534 (nobody)
    # and bind-mounts the token read-only. macOS/colima maps the container uid so
    # it can read the RAM-disk 0600 token; the native-Linux VM cannot (nobody
    # can't traverse the 0700 RAM-disk nor read a root-owned 0600 file). The
    # RAM-disk rationale (Time Machine / Spotlight / APFS snapshots) is macOS-only,
    # so on Linux render the token on-disk owned by the alertmanager uid.
    if [[ "$(uname -s)" == "Linux" ]]; then
      TOKEN_OUT="observability-rendered/telegram-token"
      TOKEN_TMP="${TOKEN_OUT}.tmp.$$"
      printf '%s' "$TELEGRAM_BOT_TOKEN" > "$TOKEN_TMP"
      chmod 600 "$TOKEN_TMP"
      # Alertmanager runs as uid 65534 (nobody) and must own/read the token. The
      # deploy user has sudo (used above for the tmpfs mount + PK read), so chown
      # via sudo and FAIL CLOSED if it can't: installing a token nobody can't read
      # would start the observability profile broken. On failure, clear the renders
      # so the profile stays DOWN (compose-up gates on alertmanager.yml existing).
      if sudo chown 65534:65534 "$TOKEN_TMP" 2>/dev/null; then
        rm -f "$TOKEN_OUT"
        mv -f "$TOKEN_TMP" "$TOKEN_OUT"
        echo "  rendered  observability/telegram-token  → on-disk, owner nobody, chmod 600 (Linux VM)"
      else
        rm -f "$TOKEN_TMP" observability-rendered/alertmanager.yml observability-rendered/telegram-token
        echo "  ERROR: could not chown telegram-token to uid 65534 (nobody); cleared" >&2
        echo "         observability renders (profile stays down). Re-run render-configs.sh" >&2
        echo "         with sudo on the VM to enable Telegram alerting." >&2
      fi
    else
      TOKEN_RAM_FILE="${RAM_PK_MOUNT}/telegram-token"
      TOKEN_TMP="${TOKEN_RAM_FILE}.tmp.$$"
      printf '%s' "$TELEGRAM_BOT_TOKEN" > "$TOKEN_TMP"
      chmod 600 "$TOKEN_TMP"
      mv -f "$TOKEN_TMP" "$TOKEN_RAM_FILE"
      # Symlink so docker-compose's existing bind-mount path keeps working.
      rm -f "observability-rendered/telegram-token"
      ln -sf "$TOKEN_RAM_FILE" "observability-rendered/telegram-token"
      echo "  rendered  observability/telegram-token  → RAM-disk (chmod 600, macOS)"
    fi
  else
    # Clear any prior render so compose-up.sh — which enables the observability
    # profile solely on observability-rendered/alertmanager.yml existing — does
    # NOT start Alertmanager with a stale config + dangling token symlink after
    # the token is removed or the RAM-disk is lost on reboot (Codex #718 P2).
    rm -f observability-rendered/alertmanager.yml observability-rendered/telegram-token
    echo "  skip      observability/* — TELEGRAM_BOT_TOKEN not set in .env"
    echo "            (cleared any stale renders; prometheus + alertmanager stay"
    echo "             down — intentional fail-closed behavior)"
  fi
fi

echo ""
echo "OK. Rendered configs are in $SCRIPT_DIR/rendered/ — gitignored, mode 600."
echo "PK-bearing driver.toml lives on RAM-disk ($RAM_PK_MOUNT) — wipes on reboot."
echo ""

# Warn if APFS local-snapshots may contain a prior Tier-1 on-disk render
# of driver.toml. Tier 1.5 prevents NEW on-disk PK exposure; it does NOT
# scrub historical snapshots / Time Machine backups. EOA rotation is the
# only complete remediation for prior exposure.
if command -v tmutil >/dev/null 2>&1; then
  snap_count=$(tmutil listlocalsnapshots / 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$snap_count" -gt 0 ]]; then
    echo "NOTE: $snap_count APFS local snapshot(s) exist. If a prior Tier-1 render"
    echo "      of driver.toml was made BEFORE this script's Tier-1.5 upgrade,"
    echo "      the snapshots may still contain the old PK literal. Tier-1.5 does"
    echo "      not scrub them retroactively — that requires either:"
    echo "        (a) Rotating the submitter EOA (see allowlist-governance-runbook.md)"
    echo "        (b) sudo tmutil deletelocalsnapshots / (wipes ALL APFS snapshots)"
    echo "      Plus checking Time Machine retention if enabled."
    echo ""
  fi
fi

echo "Bring up the stack with the wrapper:"
echo "  ./compose-up.sh                  # re-renders, stamps /api/v1/version, brings up (recommended)"
echo "OR directly (only if you JUST ran render-configs.sh):"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
echo "  NOTE: the direct path does NOT export OPHIS_GIT_DESCRIBE, so a --build"
echo "  here leaves the orderbook /api/v1/version on the vergen sentinel."
echo "  Use ./compose-up.sh for an accurate version string."
echo ""
echo "After reboot, the RAM-disk is gone. compose-up.sh handles this automatically;"
echo "raw 'docker compose up' will fail with a dangling driver.toml symlink."
