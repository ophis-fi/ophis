#!/usr/bin/env bash
set -uo pipefail
date -u
df -h /
docker ps --format '{{.Names}} {{.Status}}'
docker inspect robinhood-mainnet-driver-1 --format '{{json .State}} {{json .Config.Healthcheck}}'
docker inspect robinhood-mainnet-driver-1 --format '{{json .Config.Labels}}'
curl -sS --max-time 10 http://localhost:8411/healthz
for name in robinhood-mainnet-driver-1 robinhood-mainnet-rpc-proxy-1 robinhood-nitro-nitro-1; do
  echo "$name"
  docker logs --since 40m --tail 500 "$name" 2>&1 | sed -E 's@https?://[^ "<>]+@[RPC-URL]@g' | tail -n 60
done
for rpc in http://localhost:8547 https://rpc.mainnet.chain.robinhood.com http://localhost:4003/main/evm/4663; do
  echo "$rpc"
  curl -sS --max-time 12 -H 'content-type: application/json' -d '[{"jsonrpc":"2.0","method":"eth_blockNumber","id":1},{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665","latest"],"id":2}]' "$rpc"
done
