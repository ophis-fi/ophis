#!/usr/bin/env bash
# infra/robinhood-mainnet/nitro/restore-snapshot.sh
#
# Restore the Robinhood Chain (4663) Nitro database from a third-party snapshot,
# then let the node follow the tip. This is the sanctioned way around the fatal
# blob-DA gap (see README "From-genesis sync is NOT possible").
#
# RUNS INSIDE THE WSL2 DISTRO (Linux), after BRINGUP.md steps 1-4. It does NOT
# start the node - it only stages a verified data dir. verify-snapshot.sh then
# gates trust, and only then do you `docker compose up`.
#
# TRUST POSTURE: the default source (Titan) is operated ANONYMOUSLY. This script
# verifies the publisher's SHA256 (integrity in transit) but that does NOT prove
# the state is honest - see verify-snapshot.sh and the README trust section. Set
# SNAPSHOT_URL/SNAPSHOT_SHA256 to an official Robinhood snapshot if you obtain one.
#
# NOT YET RUN ON THIS MACHINE - authored 2026-07-22, pending the reboot. Read it
# before executing; do not pipe-to-shell trust it.
set -euo pipefail

# ── config (override via env) ─────────────────────────────────────────────────
SNAPSHOT_BASE="${SNAPSHOT_BASE:-https://snapshot.titandeployer.com}"
MANIFEST_URL="${MANIFEST_URL:-$SNAPSHOT_BASE/latest.json}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/mnt/d/nitro-download}"   # staging only; big sequential file, 9p is fine for one streamed read/write
NITRO_DATA_DIR="${NITRO_DATA_DIR:-/home/clement/robinhood-nitro-data}"
NITRO_UID="${NITRO_UID:-1000}"                          # container user `nitro`
# Pin these to bypass the manifest if you have an out-of-band checksum:
SNAPSHOT_URL="${SNAPSHOT_URL:-}"
SNAPSHOT_SHA256="${SNAPSHOT_SHA256:-}"

log(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die(){ printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

for t in curl jq sha256sum tar zstd; do command -v "$t" >/dev/null || die "missing tool: $t (see BRINGUP.md step 3)"; done

# ── 1. resolve the file + checksum from the manifest (unless pinned) ──────────
if [[ -z "$SNAPSHOT_URL" || -z "$SNAPSHOT_SHA256" ]]; then
  log "Fetching manifest: $MANIFEST_URL"
  MAN="$(curl -fsS --max-time 30 "$MANIFEST_URL")" || die "manifest fetch failed"
  echo "$MAN" | jq .
  NAME="$(echo "$MAN" | jq -r '.name')"
  SNAPSHOT_SHA256="$(echo "$MAN" | jq -r '.sha256')"
  # Download lives under /snapshots/<name>, which 302-redirects to dl.titandeployer.com
  # (verified 2026-07-23). The bare $SNAPSHOT_BASE/<name> returns 404. curl/aria2c
  # follow the redirect; do not hardcode the dl.* host (it may be a rotating CDN).
  SNAPSHOT_URL="$SNAPSHOT_BASE/snapshots/$NAME"
  [[ "$NAME" == *.tar.zst && ${#SNAPSHOT_SHA256} -eq 64 ]] || die "manifest shape unexpected (name=$NAME sha=$SNAPSHOT_SHA256)"
  cat <<EOF

  Snapshot   : $NAME
  Size       : $(echo "$MAN" | jq -r '.size')
  Built      : $(echo "$MAN" | jq -r '.date')
  SHA256     : $SNAPSHOT_SHA256
  Source     : $SNAPSHOT_URL  (ANONYMOUS publisher - integrity != honesty)

EOF
  read -r -p "Proceed with THIS file? [y/N] " ok; [[ "$ok" == [yY] ]] || die "aborted by operator"
fi

FILE="$DOWNLOAD_DIR/$(basename "$SNAPSHOT_URL")"
mkdir -p "$DOWNLOAD_DIR"

# ── 2. resumable download ─────────────────────────────────────────────────────
log "Downloading (resumable) -> $FILE"
# -C - resumes a partial file; the server sends Accept-Ranges: bytes. ~107 GB.
curl -fL -C - --retry 10 --retry-delay 15 --retry-all-errors \
     -o "$FILE" "$SNAPSHOT_URL"

# ── 3. verify checksum BEFORE touching the data dir ──────────────────────────
log "Verifying SHA256 (this reads all ~107 GB)"
ACTUAL="$(sha256sum "$FILE" | awk '{print $1}')"
[[ "$ACTUAL" == "$SNAPSHOT_SHA256" ]] || die "CHECKSUM MISMATCH
  expected $SNAPSHOT_SHA256
  actual   $ACTUAL
  The file is corrupt or was swapped. Do NOT extract it. Re-download (the
  publisher rotates daily on ~3-day retention, so the manifest sha may have moved
  under you - re-run to pick up the current file)."
log "Checksum OK: $ACTUAL"

# ── 4. extract into the data dir ──────────────────────────────────────────────
[[ -e "$NITRO_DATA_DIR" && -n "$(ls -A "$NITRO_DATA_DIR" 2>/dev/null || true)" ]] && \
  die "$NITRO_DATA_DIR is not empty. Refusing to extract over existing data. Move it aside first."
mkdir -p "$NITRO_DATA_DIR"

log "Extracting (~195 GB and growing with the chain) into $NITRO_DATA_DIR"
# The tar contains data/robinhood/nitro/{l2chaindata,arbitrumdata,nodes,wasm,...}.
# --strip-components lands the nitro/* contents directly at the data-dir root so
# it maps to /home/nitro/.arbitrum/{l2chaindata,arbitrumdata,...} in the container.
# Detect strip depth. NOTE: `grep -m1` / `sed` close the pipe early, which SIGPIPEs
# the upstream `tar` and, under `set -o pipefail`, makes the pipeline exit 141 and
# abort the whole restore. Disable pipefail for just these read-only probes.
set +o pipefail
log "Snapshot top-level layout:"
tar -I zstd -tf "$FILE" 2>/dev/null | sed -n '1,20p'
STRIP="$(tar -I zstd -tf "$FILE" 2>/dev/null | grep -m1 'l2chaindata' | awk -F/ '{for(i=1;i<=NF;i++) if($i=="l2chaindata"){print i-1; exit}}')"
set -o pipefail
[[ -n "$STRIP" ]] || die "could not locate l2chaindata in the tar - unexpected snapshot layout, inspect manually"
log "Stripping $STRIP leading path components so l2chaindata lands at the data-dir root"
tar -I zstd --strip-components="$STRIP" -xf "$FILE" -C "$NITRO_DATA_DIR"

# ── 5. wasm safety + ownership ────────────────────────────────────────────────
# The datadir may carry a `wasm` dir of NATIVE EXECUTABLE code (Stylus). Official
# guidance: do not import from an untrusted source. We DELETE it and let the node
# rebuild it locally (--init.rebuild-local-wasm defaults to "auto"). The node's
# --init.import-wasm stays false (its default) as belt-and-suspenders.
if [[ -d "$NITRO_DATA_DIR/wasm" ]]; then
  log "Removing bundled wasm dir (untrusted native code); node rebuilds it locally"
  rm -rf "$NITRO_DATA_DIR/wasm"
fi

log "Chowning to uid $NITRO_UID (container user 'nitro')"
sudo chown -R "$NITRO_UID:$NITRO_UID" "$NITRO_DATA_DIR"

cat <<EOF

$(printf '\033[1m==> Data staged.\033[0m')

NEXT (do NOT skip):
  1. ./verify-snapshot.sh        # gate trust against L1 assertions + public RPC
  2. only if it PASSES:  docker compose --env-file .env up -d
  3. docker compose logs -f nitro   # confirm it follows the tip, not re-syncs

You can delete the tarball to reclaim ~107 GB once the node is running healthily:
  rm "$FILE"
EOF
