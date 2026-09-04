#!/usr/bin/env bash
# Ophis OP mainnet — render *.toml.tmpl into ./rendered/*.toml.
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
#  14 — ERPC_IMAGE in .env disagrees with the pin tracked in .env.example
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

# Rendered-eRPC validation, factored out so it can be invoked directly:
#     ./render-configs.sh --check-rendered <file>
# exit 0 = clean, exit 16 = an upstream endpoint lost its credential.
# A guard that can only be reached by a full sudo-requiring render is a guard
# nobody tests; the review that prompted this seam rightly refused assertions
# that merely grepped this file for its own error strings.
validate_rendered_erpc() {
  local f="$1" bad=0
  if grep -nE '^[[:space:]]*endpoint:[[:space:]]*\S+/$' "$f" >&2; then
    echo "ERROR: the upstream endpoint above ends in '/' — a key substituted EMPTY." >&2
    bad=1
  fi
  if grep -nE '^[[:space:]]*endpoint:[[:space:]]*https?://[^[:space:]]*//' "$f" >&2; then
    echo "ERROR: the upstream endpoint above contains '//' mid-path — empty substitution." >&2
    bad=1
  fi
  # QUERY-PARAM keys (blockdaemon: ...?apiKey=${BLOCKDAEMON_OP_KEY}) do NOT end in
  # '/' and do NOT produce '//' when they substitute empty, so the two checks above
  # are blind to them: '...native?apiKey=' renders clean and installs a SILENTLY
  # KEYLESS lane. Catch an empty value on any query parameter.
  if grep -nE '^[[:space:]]*endpoint:[[:space:]]*https?://[^[:space:]]*[?&][A-Za-z0-9_.-]+=([&[:space:]]|$)' "$f" >&2; then
    echo "ERROR: the upstream endpoint above has an EMPTY query-param value — a key substituted EMPTY." >&2
    bad=1
  fi
  return $(( bad * 16 ))
}

if [[ "${1:-}" == "--check-rendered" ]]; then
  [[ -n "${2:-}" && -f "${2:-}" ]] || { echo "usage: $0 --check-rendered <rendered-erpc.yaml>" >&2; exit 2; }
  validate_rendered_erpc "$2" || exit 16
  echo "OK: no empty key substitutions in $2"
  exit 0
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

# Tier 1 PK isolation: refuse to render if .env still has the PK line.
# (Env-var precedence from `source .env` would mask the ophis-driver file.)
if grep -qE "^[[:space:]]*OPHIS_DRIVER_SUBMITTER_KEY=" .env; then
  echo "ERROR: .env still contains OPHIS_DRIVER_SUBMITTER_KEY — delete that line." >&2
  echo "       Tier 1 moved the PK source to /Users/ophis-driver/.config/submitter.key." >&2
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

# ── eRPC image pin: the live .env must match the pin tracked in git ──────────
# ERPC_IMAGE lives only in .env, which is gitignored, so until 2026-09-04
# nothing in the repo recorded which eRPC actually ran. That gap is not
# cosmetic. 0.0.64 carries an implicit cached-head availability gate that
# rejects an upstream BEFORE forwarding whenever its polled head trails the
# network-known highest. Measured with all three lanes on the IDENTICAL block
# it produced tenderly 0% / drpc 32% / zan 90% ErrUpstreamBlockUnavailable and
# silently cut the 2-of-3 quorum to ONE lane on the settlement-gating path,
# while erpc_consensus_errors_total stayed at zero. Upstream removed the gate
# in d655d63 (#934), first shipped in 0.1.2.
#
# Recording the pin in .env.example is not enough by itself: Compose reads
# .env, and docker-compose.yml only asserts ERPC_IMAGE is NON-EMPTY. Editing
# .env back to 0.0.64 would leave the checkout clean and start the vulnerable
# image with no warning — the exact silent rollback the record is meant to stop.
# So compare them and fail closed. Deliberately no override flag: if you are
# moving the pin on purpose, move it in .env.example in the same change so git
# keeps the record.
EXPECTED_ERPC_IMAGE="$(sed -n 's/^ERPC_IMAGE=//p' .env.example | head -1)"
if [[ -z "$EXPECTED_ERPC_IMAGE" ]]; then
  echo "ERROR: .env.example has no ERPC_IMAGE= line to check against." >&2
  echo "       The tracked pin is the only record of which eRPC we run." >&2
  exit 14
fi
if [[ "${ERPC_IMAGE:-}" != "$EXPECTED_ERPC_IMAGE" ]]; then
  echo "ERROR: ERPC_IMAGE in .env does not match the pin tracked in .env.example." >&2
  echo "         .env:         ${ERPC_IMAGE:-<unset>}" >&2
  echo "         .env.example: $EXPECTED_ERPC_IMAGE" >&2
  echo "       Refusing to render. Anything below 0.1.2 reintroduces the block-" >&2
  echo "       availability gate that thins the settlement quorum to one lane." >&2
  echo "       If this change is intentional, update .env.example too." >&2
  exit 14
fi

# ── ZAN key: migrate the legacy name, and NEVER render an empty one ──────────
# ZAN_OP_KEY was renamed to ZAN_API_KEY on 2026-07-30 (the credential is
# account-wide, not OP-specific). A .env that predates the rename — a DR host, or
# the documented "restore your backed-up .env" path — still carries only the old
# name. envsubst does not care: it would substitute the unset ZAN_API_KEY with an
# EMPTY STRING and this script would then happily install the result.
#
# That failure is silent and security-relevant, not cosmetic. The endpoint becomes
#     https://api.zan.top/node/v1/opt/mainnet/
# i.e. zan's UNREGISTERED tier, which hard-rejects eth_call / eth_getLogs /
# eth_estimateGas (-32012). Those methods would drop to a TWO-lane quorum, and
# under disputeBehavior:preferBlockHeadLeader a two-lane quorum lets a single
# hostile upstream win the tie-break by advertising the freshest head — the exact
# hole the keyed lane was introduced to close. Fail closed instead.
if [[ -z "${ZAN_API_KEY:-}" && -n "${ZAN_OP_KEY:-}" ]]; then
  echo "==> WARNING: .env uses the legacy ZAN_OP_KEY. Migrating to ZAN_API_KEY for" >&2
  echo "    this render. RENAME IT IN .env — the credential is account-wide (it also" >&2
  echo "    serves eth/mainnet, base/mainnet and arb/one), so the OP-specific name is" >&2
  echo "    misleading and this shim will be removed." >&2
  ZAN_API_KEY="$ZAN_OP_KEY"
  export ZAN_API_KEY
fi
if [[ -z "${ZAN_API_KEY:-}" ]]; then
  echo "ERROR: ZAN_API_KEY is unset/empty (and no legacy ZAN_OP_KEY to migrate)." >&2
  echo "       Refusing to render: the zan upstream would silently fall back to the" >&2
  echo "       UNREGISTERED endpoint, which rejects eth_call/eth_getLogs/eth_estimateGas" >&2
  echo "       and leaves those methods on a 2-lane quorum with no single-provider-" >&2
  echo "       compromise protection. Set ZAN_API_KEY in .env (see .env.example)." >&2
  exit 15
fi

# ── Tenderly key: NEVER render an empty one ──────────────────────────────────
# tenderly-op replaced official-op on 2026-08-29 and carries a PATH-style key.
# An empty substitution yields https://optimism.gateway.tenderly.co/ , which is
# the KEYLESS gateway: a 20 req/s bucket instead of 400, and it silently drops
# this lane's archive guarantees. validate_rendered_erpc catches the trailing
# slash, but fail fast here too so the operator sees it before the render runs.
if [[ -z "${TENDERLY_OP_KEY:-}" ]]; then
  echo "ERROR: TENDERLY_OP_KEY is unset/empty." >&2
  echo "       Refusing to render: the tenderly upstream would fall back to the" >&2
  echo "       KEYLESS gateway (20 req/s, no archive guarantee). Set it in .env." >&2
  exit 15
fi

# ── Blockdaemon key: NEVER render an empty one ───────────────────────────────
# blockdaemon-op took over the single Cloudflare slot from publicnode on
# 2026-08-29 and is the ONLY full-archive lane, so it is the deciding vote on
# eth_getTransactionReceipt and deep eth_getLogs. Its key rides in a QUERY PARAM,
# so an empty substitution renders '...native?apiKey=' — which the '/'-suffix and
# '//' checks in validate_rendered_erpc cannot see (they only catch path-style
# keys). An unauthenticated blockdaemon URL is rejected by the provider, so the
# archive bucket would drop back to the 2-capable-lane state that broke receipts
# on 2026-08-29. Fail closed here as well as in the rendered-file check.
if [[ -z "${DRPC_API_KEY:-}" ]]; then
  echo "ERROR: DRPC_API_KEY is unset/empty." >&2
  echo "       Refusing to render: the drpc upstream would render keyless," >&2
  echo "       losing the Cloudflare-slot archive lane and leaving eth_getTransactionReceipt" >&2
  echo "       and deep eth_getLogs on a 2-lane quorum. Set it in .env (.env.example)." >&2
  exit 15
fi

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
_macos_device_is_ram_image() {
  local expected_dev="$1" expected_mount="$2" plist image_count image_index
  local image_path entity_count entity_index dev_entry mount_point
  plist=$(mktemp)
  if ! hdiutil info -plist > "$plist"; then
    rm -f "$plist"
    return 1
  fi
  image_count=$(plutil -extract images raw -o - "$plist" 2>/dev/null || echo 0)
  for ((image_index = 0; image_index < image_count; image_index++)); do
    image_path=$(plutil -extract "images.${image_index}.image-path" raw -o - "$plist" 2>/dev/null || true)
    [[ "$image_path" == ram://* ]] || continue
    entity_count=$(plutil -extract "images.${image_index}.system-entities" raw -o - "$plist" 2>/dev/null || echo 0)
    for ((entity_index = 0; entity_index < entity_count; entity_index++)); do
      dev_entry=$(plutil -extract "images.${image_index}.system-entities.${entity_index}.dev-entry" raw -o - "$plist" 2>/dev/null || true)
      mount_point=$(plutil -extract "images.${image_index}.system-entities.${entity_index}.mount-point" raw -o - "$plist" 2>/dev/null || true)
      if [[ "$dev_entry" == "$expected_dev" && "$mount_point" == "$expected_mount" ]]; then
        rm -f "$plist"
        return 0
      fi
    done
  done
  rm -f "$plist"
  return 1
}

_mount_ram_disk_macos() {
  if mount | grep -Fq " on ${RAM_PK_MOUNT} ("; then
    local existing_dev
    existing_dev=$(mount | grep -F " on ${RAM_PK_MOUNT} (" | awk '{print $1}')
    if [[ ! "$existing_dev" =~ ^/dev/disk[0-9]+ ]]; then
      echo "ERROR: $RAM_PK_MOUNT mounted but device '$existing_dev' isn't /dev/disk*" >&2
      return 1
    fi
    if ! _macos_device_is_ram_image "$existing_dev" "$RAM_PK_MOUNT"; then
      echo "ERROR: $RAM_PK_MOUNT device '$existing_dev' is not a ram:// hdiutil image." >&2
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
  if ! _macos_device_is_ram_image "$dev" "$RAM_PK_MOUNT"; then
    echo "ERROR: mounted device $dev is not registered as a ram:// hdiutil image." >&2
    sudo umount -f "$RAM_PK_MOUNT" >/dev/null 2>&1 || true
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
if [[ -n "${OP_RPC_INTERNAL:-}" ]]; then
  if [[ "${ALLOW_RPC_BYPASS:-}" != "1" ]]; then
    echo "" >&2
    echo "*** REFUSING: OP_RPC_INTERNAL is set in .env ***" >&2
    echo "    Value: ${OP_RPC_INTERNAL}" >&2
    echo "    This BYPASSES the eRPC 3-of-3 consensus path and downgrades" >&2
    echo "    the stack to single-provider posture. A single hostile" >&2
    echo "    upstream can poison reads under this configuration." >&2
    echo "" >&2
    echo "    If this is intentional (failure-domain test / emergency):" >&2
    echo "      ALLOW_RPC_BYPASS=1 ./render-configs.sh" >&2
    echo "" >&2
    echo "    Otherwise: remove the OP_RPC_INTERNAL line from .env." >&2
    exit 12
  fi
  echo "" >&2
  echo "*** WARNING: OP_RPC_INTERNAL is set + ALLOW_RPC_BYPASS=1 ***" >&2
  echo "    Operating in single-provider bypass mode. Consensus disabled." >&2
  echo "    Value: ${OP_RPC_INTERNAL}" >&2
  echo "" >&2
fi

# Templates that contain substituted SECRETS (after envsubst) MUST land
# on the RAM-disk; everything else stays in ./rendered/ on disk. The
# canonical list covers the submitter PK, API credentials, and configs whose
# RPC URL may contain an embedded provider token. The post-render
# assertion below scans all non-PK_BEARING files for both PK and
# OKX-shaped secret literals, so a future template-edit that adds a
# secret-substitution to a non-listed file will fail-closed before the
# stack starts.
# 2026-07-23: erpc.yaml joined this list. It previously carried zero secrets
# (free upstreams), but the keyed validationcloud/blockdaemon migration puts two
# live provider keys in it. Route it to the RAM-disk like every other secret-
# bearing render (Time-Machine / APFS-snapshot / Spotlight protection) rather than
# leaving it on the FileVault SSD — matches how enso/okx keys are handled, and
# the post-render leak assertion below cannot pattern-match these key shapes anyway.
PK_BEARING_NAMES=(driver.toml okx.toml enso.toml curve.toml woofi.toml erpc.yaml)

is_pk_bearing() {
  local n="$1"
  local p
  for p in "${PK_BEARING_NAMES[@]}"; do
    if [[ "$n" == "$p" ]]; then return 0; fi
  done
  return 1
}

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
  # ${VARS} in eRPC's YAML syntax, defensive against future config additions.
  envsubst '${OP_MAINNET_RPC} ${OKX_PROJECT_ID} ${OKX_API_KEY} ${OKX_SECRET_KEY} ${OKX_PASSPHRASE} ${ENSO_API_KEY} ${OPHIS_DRIVER_SUBMITTER_KEY} ${VALIDATIONCLOUD_OP_KEY} ${BLOCKDAEMON_OP_KEY} ${DRPC_API_KEY} ${TENDERLY_OP_KEY} ${ZAN_API_KEY}' \
    < "$tmpl" > "$out_tmp"
  # Redundant under `umask 077` set at script top, but kept as defense-
  # in-depth against a future edit that hoists or removes the umask.
  chmod 600 "$out_tmp"

  # Generic empty-substitution guard, checked BEFORE the file is installed.
  # envsubst turns any unset variable into an empty string, so a renamed or
  # forgotten key silently yields a credential-less URL that still parses and
  # still starts. For erpc.yaml that means quietly demoting a keyed upstream to
  # its anonymous tier (see the ZAN_API_KEY note above). Catch the shape rather
  # than enumerating every key, so the next renamed variable is caught too.
  if [[ "$name" == "erpc.yaml" ]]; then
    if ! validate_rendered_erpc "$out_tmp"; then
      echo "       Refusing to install $out. Check the *_KEY vars in .env." >&2
      rm -f "$out_tmp"; exit 16
    fi
  fi

  mv -f "$out_tmp" "$out"

  if is_pk_bearing "$name"; then
    echo "  rendered  $name  → RAM-disk ($RAM_PK_MOUNT)"
  else
    echo "  rendered  $name"
  fi
done

# Prune ORPHANED renders: a rendered/<name> whose configs/<name>.tmpl no longer
# exists. The render loop above only ever visits names derived from a template
# that IS present, so deleting a template silently strands its last render.
#
# This is not cosmetic. A PK-bearing orphan (odos.toml, when the Odos lane was
# retired) is a SYMLINK into the RAM-disk still holding that lane's live API key,
# referenced by nothing. The leak assertion below cannot see it either: it scans
# `find rendered -type f`, and both `-type f` and its `! -L` guard skip symlinks.
# So without this pass the credential survives until the RAM-disk is unmounted.
#
# Deliberately unlinks the RAM-disk target BEFORE the symlink, because once the
# symlink is gone the target's path is no longer discoverable from here.
for rendered_path in rendered/*.toml rendered/*.yaml; do
  [[ -e "$rendered_path" || -L "$rendered_path" ]] || continue
  rendered_name="$(basename "$rendered_path")"
  [[ -f "configs/${rendered_name}.tmpl" ]] && continue

  if [[ -L "$rendered_path" ]]; then
    orphan_target="$(readlink "$rendered_path")"
    # Only follow the link into the RAM-disk we manage; never delete an
    # arbitrary path a hand-edited symlink happens to point at.
    if [[ "$orphan_target" == "${RAM_PK_MOUNT}/"* && -f "$orphan_target" ]]; then
      rm -f "$orphan_target"
      echo "  pruned    ${rendered_name} (orphaned; also removed its RAM-disk render)"
    else
      echo "  pruned    ${rendered_name} (orphaned symlink; target left untouched)"
    fi
  else
    echo "  pruned    ${rendered_name} (orphaned)"
  fi
  rm -f "$rendered_path"
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
    # 64-hex `"0x..."` — submitter PK pattern.
    if grep -qE '"0x[a-fA-F0-9]{64}"' "$f" 2>/dev/null; then
      violating_files+=("$f (PK literal)")
      continue
    fi
    # OKX api-key: `[uuid-shaped]` (8-4-4-4-12 hex with dashes).
    if grep -qE 'api-key = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"' "$f" 2>/dev/null; then
      violating_files+=("$f (OKX api-key)")
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
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    # Render alertmanager.yml.tmpl → observability-rendered/alertmanager.yml
    for tmpl in observability/*.yml.tmpl; do
      name="$(basename "$tmpl" .tmpl)"
      out_tmp="observability-rendered/${name}.tmp.$$"
      envsubst '${TELEGRAM_BOT_TOKEN}' < "$tmpl" > "$out_tmp"
      chmod 600 "$out_tmp"
      mv -f "$out_tmp" "observability-rendered/${name}"
      echo "  rendered  observability/$name"
    done
    # Token in a chmod-600 file on the RAM-disk (sharp-edges HIGH-4
    # follow-up: same persistent-storage threat model as the PK — Time
    # Machine / APFS local snapshots / Spotlight could otherwise retain
    # the bot token across rotations). A leaked bot token lets an
    # attacker DM Clement as the alert bot → phishing primitive against
    # the very operator who'd act on alerts.
    TOKEN_RAM_FILE="${RAM_PK_MOUNT}/telegram-token"
    TOKEN_TMP="${TOKEN_RAM_FILE}.tmp.$$"
    printf '%s' "$TELEGRAM_BOT_TOKEN" > "$TOKEN_TMP"
    chmod 600 "$TOKEN_TMP"
    mv -f "$TOKEN_TMP" "$TOKEN_RAM_FILE"
    # Symlink from observability-rendered/ so docker-compose's existing
    # bind-mount path (./observability-rendered/telegram-token) keeps working.
    rm -f "observability-rendered/telegram-token"
    ln -sf "$TOKEN_RAM_FILE" "observability-rendered/telegram-token"
    echo "  rendered  observability/telegram-token  → RAM-disk (chmod 600)"
  else
    echo "  skip      observability/* — TELEGRAM_BOT_TOKEN not set in .env"
    echo "            (prometheus + alertmanager containers will fail to start;"
    echo "             that's intentional fail-closed behavior)"
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
