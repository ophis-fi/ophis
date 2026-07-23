#!/usr/bin/env bash
# Keeps the Robinhood Nitro node alive on a Windows/WSL2 host.
#
# WHY THIS EXISTS: WSL2 shuts the distro's VM down ~60s after the LAST wsl session
# closes (vmIdleTimeout=-1 is NOT honored - observed 2026-07-23), which stops the
# container. This script runs as ONE long-lived wsl session, so it (a) holds the
# VM up and (b) re-asserts `docker compose up -d` every couple minutes so the
# container is running (belt-and-suspenders alongside the compose `restart: always`).
#
# It is launched by a Windows Task Scheduler task at the distro-owner's logon -
# see BRINGUP.md step 7. Copy it into the distro (e.g. /home/<user>/keepalive-node.sh,
# chmod +x). Adjust the path below to wherever the node's docker-compose.yml + .env live.
set -u
NODE_DIR="${NODE_DIR:-/home/clement/robinhood-nitro}"
cd "$NODE_DIR" || { echo "keepalive: NODE_DIR $NODE_DIR not found" >&2; exit 1; }
while true; do
  docker compose --env-file .env up -d >/dev/null 2>&1 || true
  sleep 120
done
