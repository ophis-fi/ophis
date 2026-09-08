#!/usr/bin/env bash
set -uo pipefail
date -u
git -C /home/clement/ophis status --short
git -C /home/clement/ophis log -1 --oneline
cat /home/clement/ophis/apps/backend/crates/driver/src/infra/api/routes/healthz.rs | head -n 80
ls -ld /home/clement/ophis/apps/backend/target /home/clement/ophis/apps/backend/target/release /home/clement/.cargo 2>/dev/null || true
docker inspect robinhood-mainnet-driver-1 --format '{{.Image}} {{.Config.Image}} {{json .Config.Labels}}'
docker image inspect local-driver:latest --format '{{.Id}} {{.Created}}'
docker builder du | tail -n 4
curl -sS --max-time 15 -H 'content-type: application/json' -d '[{"jsonrpc":"2.0","method":"eth_gasPrice","id":1},{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":2}]' http://localhost:8547 | python3 -c 'import json,sys; x=json.load(sys.stdin); print(json.dumps([{ "id":r["id"],"result": ({k:r["result"].get(k) for k in ["number","timestamp","gasUsed","baseFeePerGas"]} if isinstance(r.get("result"),dict) else r.get("result"))} for r in x]))'
