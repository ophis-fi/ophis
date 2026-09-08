#!/usr/bin/env bash
set -euo pipefail
expected_image=sha256:c28593b91d39d7013a33a865ef22ce0eb9de4a17c663448e59d8bbbddafcd36a
expected_start=2026-09-08T09:20:56.41131899Z
for i in 1 2 3; do
  date -u
  test "$(docker inspect robinhood-mainnet-driver-1 --format '{{.Image}}')" = "$expected_image"
  test "$(docker inspect robinhood-mainnet-driver-1 --format '{{.State.StartedAt}}')" = "$expected_start"
  test "$(docker inspect robinhood-mainnet-driver-1 --format '{{.State.Health.Status}}')" = healthy
  curl -fsS --max-time 10 http://localhost:8411/healthz
  docker inspect robinhood-mainnet-driver-1 --format '{{.State.StartedAt}} {{.State.Health.Status}} failures={{.State.Health.FailingStreak}} restarts={{.RestartCount}}'
  if [ "$i" != 3 ]; then sleep 60; fi
done
docker ps --filter name=robinhood-mainnet --format '{{.Names}} {{.Status}}'
echo 'Driver remains healthy with no restarts since repair'
