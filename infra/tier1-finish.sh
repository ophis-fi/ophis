#!/usr/bin/env bash
# Tier 1 PK Isolation — finish steps 5A-D.
#
# Prereqs: tier1-pk-isolation-setup.sh already ran successfully (Steps 1-4).
# Run as scep. One sudo prompt at the start; timestamp covers everything else.
#
# What this does:
#   - Creates /Users/ophis-driver/rendered/<chain>/ dirs (0700, ophis-driver-owned)
#   - Runs render-configs.sh per chain (renders driver.toml under ophis-driver's home)
#   - Force-recreates the driver container per chain so it picks up the new bind mount
#   - Drains scep's keychain entry (5D)
#
# .env files have had OPHIS_DRIVER_SUBMITTER_KEY deleted (in the pre-flight commit).
# The render-configs.sh of each chain fails-loud if the line was re-added.
#
# Idempotent. If the keychain entry is already drained, Step 5 is a no-op.

set -euo pipefail

REPO="/Users/scep/greg"
DRIVER_USER="ophis-driver"
KEYCHAIN_SVC="ophis-driver-submitter-2026-05-14"
CHAINS=(optimism-mainnet megaeth-mainnet hyperevm-mainnet)

if [[ "$(id -un)" != "scep" ]]; then
  echo "ERROR: run as user 'scep' (current: $(id -un))." >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: do NOT run as root." >&2
  exit 1
fi

echo "=== Step 1: Create ophis-driver rendered dirs ==="
sudo -u "$DRIVER_USER" mkdir -p \
  "/Users/$DRIVER_USER/rendered/optimism-mainnet" \
  "/Users/$DRIVER_USER/rendered/hyperevm-mainnet" \
  "/Users/$DRIVER_USER/rendered/megaeth-mainnet"
sudo chmod 700 "/Users/$DRIVER_USER/rendered"
sudo chown "$DRIVER_USER":staff "/Users/$DRIVER_USER/rendered"
for c in "${CHAINS[@]}"; do
  sudo chmod 700 "/Users/$DRIVER_USER/rendered/$c"
  sudo chown "$DRIVER_USER":staff "/Users/$DRIVER_USER/rendered/$c"
done
echo "  ✓ rendered dirs created (mode 0700, owner $DRIVER_USER)"

echo ""
echo "=== Step 2: Render configs per chain ==="
for chain in "${CHAINS[@]}"; do
  echo "--- $chain ---"
  (cd "$REPO/infra/$chain" && ./render-configs.sh)
done

echo ""
echo "=== Step 3: Recreate driver containers ==="
# --no-deps: don't restart unrelated services; only the driver's bind mount changed.
for chain in "${CHAINS[@]}"; do
  echo "--- $chain driver ---"
  if ! docker compose -f "$REPO/infra/$chain/docker-compose.yml" up -d --force-recreate --no-deps driver 2>&1 | tail -3; then
    echo "  ⚠ $chain driver recreate had issues — check logs."
  fi
done

echo ""
echo "=== Step 4: Wait up to 60s for drivers to become healthy ==="
for chain in "${CHAINS[@]}"; do
  c="${chain}-driver-1"
  printf "  %-30s " "$c:"
  status="unknown"
  for i in {1..30}; do
    status=$(docker inspect "$c" --format='{{.State.Health.Status}}' 2>/dev/null || echo missing)
    if [[ "$status" == "healthy" ]]; then
      echo "✓ healthy"
      break
    fi
    sleep 2
  done
  [[ "$status" != "healthy" ]] && echo "✗ status=$status (may be downstream-blocked, check container logs)"
done

echo ""
echo "=== Step 5: Verify scep CANNOT read any rendered driver.toml ==="
fail=0
for chain in "${CHAINS[@]}"; do
  path="/Users/$DRIVER_USER/rendered/$chain/driver.toml"
  if cat "$path" >/dev/null 2>&1; then
    echo "  ✗ $path is readable by scep — filesystem ACL broken!"
    fail=1
  else
    echo "  ✓ $path NOT readable by scep"
  fi
done
if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "REFUSING to drain scep's keychain entry — isolation not verified."
  exit 7
fi

echo ""
echo "=== Step 6: Drain scep keychain entry (5D) ==="
if security find-generic-password -s "$KEYCHAIN_SVC" >/dev/null 2>&1; then
  security delete-generic-password -s "$KEYCHAIN_SVC"
  echo "  ✓ Drained scep keychain entry '$KEYCHAIN_SVC'."
  echo "    PK now lives only at /Users/$DRIVER_USER/.config/submitter.key."
else
  echo "  Already absent (idempotent — no-op)."
fi

echo ""
echo "=== Tier 1 complete ==="
echo "  PK source: /Users/$DRIVER_USER/.config/submitter.key (mode 0600, owner $DRIVER_USER)"
echo "  Driver configs: /Users/$DRIVER_USER/rendered/<chain>/driver.toml (mode 0600, owner $DRIVER_USER)"
echo "  Isolation: filesystem ACL on /Users/$DRIVER_USER (mode 0700) — scep cannot read."
echo "  Old scep keychain entry: drained."
echo ""
echo "  Rollback: PK file at /Users/$DRIVER_USER/.config/submitter.key still exists;"
echo "  re-import to scep's keychain with: security add-generic-password -s \\"
echo "    '$KEYCHAIN_SVC' -a '$KEYCHAIN_SVC' -w \"\$(sudo cat /Users/$DRIVER_USER/.config/submitter.key)\""
