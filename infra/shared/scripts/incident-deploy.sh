#!/usr/bin/env bash
set -euo pipefail
cd /home/clement/ophis
test "$(git rev-parse HEAD)" = 14b213b2ef6042467cb2ed2496107feb28e81cb0
git diff --quiet
expected=sha256:cb1c148ae8345167d05257499ac9c0a89ccf0ea18b9d32e691f2411233b2ce9c
test "$(docker inspect robinhood-mainnet-driver-1 --format '{{.Image}}')" = "$expected"
git apply --check /tmp/robinhood-healthz-20260908.patch
rollback() {
  set +e
  echo 'Restoring previous driver'
  docker tag "$expected" local-driver:latest
  cd /home/clement/ophis/infra/robinhood-mainnet
  docker compose up -d --no-deps --force-recreate driver
  cd ../..
  git apply -R --check /tmp/robinhood-healthz-20260908.patch && git apply -R /tmp/robinhood-healthz-20260908.patch
}
verified=0
trap 'if [ "$verified" = 0 ]; then rollback; fi' EXIT
docker tag "$expected" local-driver:before-healthfix-20260908
git apply /tmp/robinhood-healthz-20260908.patch
docker tag local-driver:healthfix-20260908 local-driver:latest
cd infra/robinhood-mainnet
docker compose up -d --no-deps --force-recreate driver
for i in {1..30}; do
  if curl -fsS --max-time 8 http://localhost:8411/healthz &&
     test "$(docker inspect robinhood-mainnet-driver-1 --format '{{.State.Health.Status}}')" = healthy; then
    docker inspect robinhood-mainnet-driver-1 --format '{{.Image}} {{.State.StartedAt}} {{.State.Health.Status}}'
    verified=1
    echo 'Robinhood driver health restored with the tested 0.002 ETH floor'
    exit 0
  fi
  sleep 5
done
echo 'Health gate failed'
exit 1
