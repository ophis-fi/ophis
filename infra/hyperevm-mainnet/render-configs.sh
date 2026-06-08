#!/usr/bin/env bash
# Ophis HyperEVM mainnet — render *.toml.tmpl into ./rendered/*.toml.
#
# The CoW solver TOML parser doesn't substitute env vars at parse time, so
# we pre-render TOML templates that need secrets (driver-submitter PK +
# Alertmanager Telegram token). Rendered TOMLs go to ./rendered/ which is
# gitignored. Reads non-PK secrets from ./.env (also gitignored).
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
# **What Tier 1 did NOT achieve (mirrors OP Phase 4 audit H1):**
#   - The rendered driver.toml STILL lived at ./rendered/driver.toml under
#     scep's home directory (mode 0600 owner=scep). Any process running as
#     scep could read it. This was NOT "isolation from scep"; it was
#     "isolation from random other-user processes".
#
# ## Tier 1.5 RAM-disk render (this script, ported from OP 2026-05-21)
#
# Mirrors infra/optimism-mainnet/render-configs.sh post-PR #140 + #176.
# Writes the rendered driver.toml + Telegram bot-token file to a RAM-backed
# volume that wipes on reboot. ./rendered/driver.toml becomes a symlink
# pointing into the RAM-disk. docker-compose's bind-mount
# (./rendered/driver.toml:/driver.toml:ro) follows the symlink through
# colima's virtiofs.
#
# What this closes:
#   - No persistent SSD trace (RAM-disk wipes on reboot/poweroff)
#   - No Time Machine inclusion (TM ignores /dev/disk* ramdisks)
#   - No Spotlight index (mdutil -i off applied)
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
# The compose-up.sh wrapper handles this automatically.
#
# Volume namespace: this stack uses `ram-pk-hl` (vs OP's `ram-pk`) so both
# stacks can run concurrently on the same host without mount collision.
#
# ## Exit codes
#   1 — .env missing
#   2 — running under set -x (secrets would leak in trace)
#   4 — .env still has legacy OPHIS_DRIVER_SUBMITTER_KEY line
#   5 — PK file at $OPHIS_SUBMITTER_KEY_PATH is malformed
#   6 — RAM-disk mount failed
#   7 — post-render secret-leak assertion fired
#  12 — RPC bypass var set without explicit ACK (reserved; unused on HL today)

set -euo pipefail

# Defense-in-depth: rendered files contain the driver-submitter PK and the
# Telegram bot token. With the default macOS umask of 022, `envsubst > file`
# creates 0644 momentarily before the explicit `chmod 600` tightens. A
# process watching the directory could open() during that window.
# `umask 077` ensures every `>` produces 0600 from the start; later
# `chmod 600` calls stay as belt-and-braces.
umask 077

# Refuse to run under `set -x` / `bash -x`: the sudo cat below traces the
# PK if -x is set.
if [[ "${-}" == *x* ]]; then
  echo "REFUSING to run under set -x: secrets would leak in the trace." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Preflight: stale-config detection (mirrors OP render-configs.sh).
# A6 whole-repo audit H1 (2026-05-21): the Tier-1→1.5 migration on the
# OP side left `configs/driver.toml` git-tracked next to its .tmpl.
# Same risk applies symmetrically on HL — keep the stacks aligned by
# enforcing the same invariant here. Reject any non-tmpl config that
# contains placeholder syntax (%X or ${X}) — they should either be
# canonical (no placeholders) or rendered (to ./rendered/), never both.
stale_with_placeholder=()
shopt -s nullglob
for cfg in configs/*.toml configs/*.yaml; do
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
  echo "  These look like leftover rendered output. Decide whether the file" >&2
  echo "  is canonical (keep, delete .tmpl) or rendered (delete, keep .tmpl)" >&2
  echo "  and re-run." >&2
  exit 13
fi

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $SCRIPT_DIR — copy from .env.example first" >&2
  exit 1
fi

# Tier 1 PK isolation: refuse to render if .env still has the PK line.
# (Env-var precedence from `source .env` would mask the ophis-driver file.)
# Matches even an empty `OPHIS_DRIVER_SUBMITTER_KEY=` form — mirrors OP
# render-configs.sh:84. Forces operators to delete the line during initial
# setup so the .env.example guidance ("delete this line") is enforced
# (sharp-edges H1, PR #200 review).
if grep -qE "^[[:space:]]*OPHIS_DRIVER_SUBMITTER_KEY=" .env; then
  echo "ERROR: .env still contains OPHIS_DRIVER_SUBMITTER_KEY — delete that line." >&2
  echo "       Tier 1 moved the PK source to /Users/ophis-driver/.config/submitter.key." >&2
  exit 4
fi

# Tighten .env perms BEFORE reading it (mirrors OP sharp-edges MED-3):
# chmod 600 after `source` would leave the file world-readable during the
# read window. Idempotent — chmod is a no-op if already 600.
chmod 600 .env

# Load .env into this shell so envsubst sees the non-PK vars.
set -a
# shellcheck disable=SC1091
source .env
set +a

# Resolve PK file path with Darwin/Linux portability (mirrors OP G1, PR #163).
# Operator can override via OPHIS_SUBMITTER_KEY_PATH if the user layout differs.
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

# Fail FAST if any required NON-PK secret is missing — otherwise envsubst
# silently substitutes empty string and the driver/orderbook fails far
# downstream with an opaque error. Each :? guard prints the named var + hint.
: "${ALCHEMY_API_KEY:?must be set in .env — see .env.example}"
: "${HYPEREVM_MAINNET_RPC:?must be set in .env — see .env.example}"
: "${HYPEREVM_RPC_INTERNAL:?must be set in .env — see .env.example}"

# Default to the verified-live Ormi-hosted HyperSwap V3 subgraph.
# Distinguish "unset" (= use default) from "set to empty" (= operator error)
# — see [[feedback-dont-fabricate-address-ellipsis]]-style hardening pattern.
# To DISABLE V3 routing the operator must comment out the
# [[liquidity.uniswap-v3]] block in driver.toml.tmpl directly.
if [[ -n "${HYPERSWAP_V3_SUBGRAPH_URL+x}" ]] && [[ -z "$HYPERSWAP_V3_SUBGRAPH_URL" ]]; then
  echo "ERROR: HYPERSWAP_V3_SUBGRAPH_URL is set but empty." >&2
  echo "  - To use the default (Ormi-hosted) subgraph: unset the var or remove the line in .env." >&2
  echo "  - To use a custom subgraph: set HYPERSWAP_V3_SUBGRAPH_URL to its https URL." >&2
  echo "  - To DISABLE HyperSwap V3 routing entirely: comment out the [[liquidity.uniswap-v3]]" >&2
  echo "    block in infra/hyperevm-mainnet/configs/driver.toml.tmpl. Restart driver after." >&2
  exit 2
fi
: "${HYPERSWAP_V3_SUBGRAPH_URL:=https://api.subgraph.ormilabs.com/api/public/33c67399-d625-4929-b239-5709cd66e422/subgraphs/hyperswap-v3/v0.1.2/gn}"
export HYPERSWAP_V3_SUBGRAPH_URL

# Subgraph URL must look like a Goldsky-style or Ormi-style https endpoint.
# Sharp-edges audit (2026-05-17) tightened from `^https://.+/[^/]+` (which
# accepted whitespace/quotes/newlines) to a strict RFC-3986-safe shape with
# both anchors and explicit host/port/path character classes.
url_re='^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~!$&'\''()*+,;=:@%/?#-]+)+$'
if [[ ! "$HYPERSWAP_V3_SUBGRAPH_URL" =~ $url_re ]]; then
  echo "ERROR: HYPERSWAP_V3_SUBGRAPH_URL fails URL shape check (RFC-3986-safe https://host[:port]/path)" >&2
  exit 2
fi

# Resolve TELEGRAM_BOT_TOKEN — preferred source is macOS Keychain
# (mirrors OP Phase 1.5, PR #154). Keeps the token out of .env cleartext and
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
# The -U flag updates if the entry already exists. Shared service name with
# OP stack — same @clawdiusfranciscus_bot for both alerts pipelines.
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
    exit 2
  fi
fi

mkdir -p rendered
shopt -s nullglob

# ── Tier 1.5 RAM-disk PK render (ported from OP, 2026-05-21) ──────────────
#
# See header docstring for full design rationale. Volume namespace is
# `ram-pk-hl` / `ophis-ram-pk-hl` (vs OP's `ram-pk` / `ophis-ram-pk`) so
# both stacks can run concurrently on the same host.

RAM_PK_MOUNT="$HOME/.local/state/ophis/ram-pk-hl"
RAM_PK_VOLNAME="ophis-ram-pk-hl"
RAM_PK_SIZE_SECTORS=2048   # 2048 * 512B = 1 MB

# Idempotent mount. Exits non-zero on failure — we WANT this to hard-fail
# rather than fall through to writing the PK on disk.
#
# Mirrors OP's marker-file pattern (PR #147): existing-mount check uses a
# marker file inside the volume rather than diskutil's volume name
# (newfs_hfs labels are invisible to diskutil for ram-disks).
mount_ram_disk() {
  case "$(uname -s)" in
    Darwin) _mount_ram_disk_macos ;;
    Linux)  _mount_ram_disk_linux ;;
    *)      echo "ERROR: unsupported platform $(uname -s) for RAM-disk mount" >&2; return 1 ;;
  esac
}

# Linux variant — uses tmpfs (kernel-resident pages, no disk).
# Mirrors OP G2 portability fix (PR #163).
_mount_ram_disk_linux() {
  if mount | grep -qE " ${RAM_PK_MOUNT} type tmpfs"; then
    local marker="${RAM_PK_MOUNT}/.ophis-ram-pk-marker"
    if [[ ! -f "$marker" ]] || ! grep -qFx "$RAM_PK_VOLNAME" "$marker" 2>/dev/null; then
      echo "ERROR: $RAM_PK_MOUNT mounted but marker file missing/wrong." >&2
      echo "       To recover: sudo umount $RAM_PK_MOUNT && re-run." >&2
      return 1
    fi
    return 0  # confirmed: our tmpfs
  fi
  mkdir -p "$RAM_PK_MOUNT"
  if ! sudo mount -t tmpfs tmpfs "$RAM_PK_MOUNT" \
       -o "size=1M,mode=0700,uid=$(id -u),gid=$(id -g)"; then
    echo "ERROR: tmpfs mount at $RAM_PK_MOUNT failed (need passwordless sudo for mount)" >&2
    return 1
  fi
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

  echo "  mounted RAM-disk at $RAM_PK_MOUNT (device $dev, 1 MB, HFS+, volname=$RAM_PK_VOLNAME)"
}

if ! mount_ram_disk; then
  echo "FATAL: could not mount RAM-disk for PK-bearing config. Refusing to" >&2
  echo "       fall through to disk-write of driver.toml. Investigate:" >&2
  echo "       - hdiutil + diskutil available?" >&2
  echo "       - \$HOME/.local/state/ophis/ram-pk-hl writable?" >&2
  echo "       - existing stale mount? (mount | grep ophis-ram-pk-hl; diskutil unmount ...)" >&2
  exit 6
fi

# Disable Spotlight indexing on the RAM-disk on EVERY render (sharp-edges M3,
# PR #200 review). Previously only ran on fresh-mount path inside
# _mount_ram_disk_macos — meaning a reboot-loop where the operator manually
# re-mounted would re-enable indexing on the existing-mount path. Now
# applied unconditionally post-mount. Best-effort (|| true) on Linux (no
# mdutil) and older macOS versions.
if [[ "$(uname -s)" == "Darwin" ]] && command -v mdutil >/dev/null 2>&1; then
  mdutil -i off "$RAM_PK_MOUNT" >/dev/null 2>&1 || true
fi

# Templates that contain substituted SECRETS (after envsubst) MUST land on
# the RAM-disk; everything else stays in ./rendered/ on disk. HL has fewer
# secret-bearing templates than OP (no OKX) — driver.toml is the only one.
# The post-render assertion below scans all non-PK_BEARING files for PK
# literals, so a future template-edit that adds a secret-substitution to a
# non-listed file will fail-closed before the stack starts.
PK_BEARING_NAMES=(driver.toml)

is_pk_bearing() {
  local n="$1"
  local p
  for p in "${PK_BEARING_NAMES[@]}"; do
    if [[ "$n" == "$p" ]]; then return 0; fi
  done
  return 1
}

for tmpl in configs/*.toml.tmpl configs/*.yaml.tmpl; do
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

  # Atomic-write: render to a temp file in the same dir, chmod, then `mv`
  # (rename within the same filesystem is atomic on macOS HFS+ and APFS).
  # Without this, a concurrent `docker compose up` could read an
  # empty/partial config during the envsubst write window.
  envsubst '${ALCHEMY_API_KEY} ${HYPEREVM_MAINNET_RPC} ${HYPEREVM_RPC_INTERNAL} ${OPHIS_DRIVER_SUBMITTER_KEY} ${HYPERSWAP_V3_SUBGRAPH_URL}' \
    < "$tmpl" > "$out_tmp"
  # Redundant under `umask 077` set at script top, but kept as defense-
  # in-depth against a future edit that hoists or removes the umask.
  chmod 600 "$out_tmp"
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

# Post-render secret-leak assertion: if a future template-edit introduces
# a secret-substitution into a file NOT in PK_BEARING_NAMES (or NOT a
# RAM-disk symlink target), the prior loop would silently write the secret
# to disk. Scan all NON-symlink files in rendered/ AND observability-
# rendered/ for both the PK literal AND the Telegram bot-token pattern.
# Fail closed on any match.
#
# Sharp-edges H3 + Codex MED-1 (PR #200 review): the prior scan only
# covered rendered/ for PK literals. A future template-edit that adds
# ${TELEGRAM_BOT_TOKEN} substitution to a non-observability template, or
# adds a PK substitution to alertmanager.yml.tmpl, would slip through.
# Now both directories + both patterns are covered.
#
# We grep for the patterns, not the values themselves, so the assertion
# check doesn't itself surface the secret in error messages.
violating_files=()
scan_dirs=(rendered)
if [[ -d observability-rendered ]]; then
  scan_dirs+=(observability-rendered)
fi
while IFS= read -r f; do
  if [[ -n "$f" && ! -L "$f" ]]; then
    # 64-hex `"0x..."` — submitter PK pattern.
    if grep -qE '"0x[a-fA-F0-9]{64}"' "$f" 2>/dev/null; then
      violating_files+=("$f (PK literal)")
      continue
    fi
    # Telegram bot-token shape: `{int}:{base64-ish 20+ chars}`. Matches
    # whether the token is in a TOML string, YAML scalar, or bare key=val.
    if grep -qE '[0-9]+:[A-Za-z0-9_-]{20,}' "$f" 2>/dev/null; then
      violating_files+=("$f (Telegram token literal)")
      continue
    fi
  fi
done < <(find "${scan_dirs[@]}" -maxdepth 1 -type f \( -name "*.toml" -o -name "*.yaml" -o -name "*.yml" \))

if (( ${#violating_files[@]} > 0 )); then
  echo "" >&2
  echo "FATAL: secret literal found in non-RAM-disk rendered files:" >&2
  for f in "${violating_files[@]}"; do
    echo "  - $f" >&2
  done
  echo "" >&2
  echo "  A template now substitutes a secret (\${OPHIS_DRIVER_SUBMITTER_KEY}" >&2
  echo "  or \${TELEGRAM_BOT_TOKEN}) into a file that isn't a RAM-disk symlink." >&2
  echo "  Either:" >&2
  echo "    a) Add the name to PK_BEARING_NAMES so it lands on RAM-disk, OR" >&2
  echo "    b) Stop substituting the secret in that template (use bot_token_file" >&2
  echo "       pattern for Alertmanager — see observability/alertmanager.yml.tmpl)." >&2
  echo "  Scrub the listed file(s) — they contain live secrets." >&2
  exit 7
fi

# ── Render observability/alertmanager (Telegram token on RAM-disk) ────────
# Same pattern as OP stack: Alertmanager reads its bot token from a chmod-600
# file (bot_token_file in YAML) rather than env-var-injected, to avoid
# `docker inspect` env leak. Tier 1.5 puts the token on the RAM-disk too —
# leaked-token threat model matches the PK (Time Machine / APFS local
# snapshots / Spotlight could otherwise retain the bot token across
# rotations).
if [[ -d observability ]]; then
  mkdir -p observability-rendered
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    # Render alertmanager.yml.tmpl → observability-rendered/alertmanager.yml
    #
    # Defensive: pass a single nonexistent sentinel var to envsubst (no real
    # vars substituted). The current alertmanager.yml.tmpl uses bot_token_file
    # (no direct ${TELEGRAM_BOT_TOKEN} substitution), so this is a no-op today.
    # Prevents a future template-edit from accidentally enabling token
    # substitution to SSD (Codex MED-1, PR #200 review).
    #
    # Sharp-edges sign-off M1: using a sentinel rather than `envsubst ''`
    # because the Go-port envsubst (a8m/envsubst, occasionally aliased in
    # dev shells) treats empty allowlist as "substitute everything", which
    # would silently leak ${TELEGRAM_BOT_TOKEN} to SSD if it ever shadows
    # GNU envsubst in PATH. GNU and Go-port both honor a SHELL-FORMAT
    # listing a nonexistent var as "substitute nothing".
    for tmpl in observability/*.yml.tmpl; do
      name="$(basename "$tmpl" .tmpl)"
      out_tmp="observability-rendered/${name}.tmp.$$"
      envsubst '${__OPHIS_NO_SUBST_SENTINEL__}' < "$tmpl" > "$out_tmp"
      chmod 600 "$out_tmp"
      mv -f "$out_tmp" "observability-rendered/${name}"
      echo "  rendered  observability/$name"
    done
    # Token in a chmod-600 file on the RAM-disk. A leaked bot token lets
    # an attacker DM Clement as the alert bot → phishing primitive against
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
    echo "        (a) Rotating the submitter EOA on the HYPEREVM solver allowlist"
    echo "            via the HyperEVM Safe (evict the old EOA, allowlist a fresh one)."
    echo "            NOTE: allowlist-governance-runbook.md is OP-mainnet-only — do"
    echo "            NOT follow it here; it targets the wrong chain's allowlist/Safe."
    echo "        (b) sudo tmutil deletelocalsnapshots / (wipes ALL APFS snapshots)"
    echo "      Plus checking Time Machine retention if enabled."
    echo ""
  fi
fi

echo "Bring up the stack with the wrapper:"
echo "  ./compose-up.sh                  # re-renders + brings up (recommended)"
echo "OR directly (only if you JUST ran render-configs.sh):"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml up -d --build"
echo ""
echo "After reboot, the RAM-disk is gone. compose-up.sh handles this automatically;"
echo "raw 'docker compose up' will fail with a dangling driver.toml symlink."
