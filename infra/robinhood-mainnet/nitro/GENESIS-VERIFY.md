# Independently derived Robinhood node

This is the promotion runbook for `nitro-genesis`. It deliberately never imports
the Titan database. Do not point eRPC at this service until every gate passes.

## Start

Set a new empty ext4 directory in `nitro/.env`:

```dotenv
NITRO_GENESIS_DATA_DIR=/home/clement/robinhood-nitro-genesis-data
```

The path must differ from `NITRO_DATA_DIR`. Then:

```bash
install -d -m 700 "$NITRO_GENESIS_DATA_DIR"
docker compose -f docker-compose.yml -f docker-compose.genesis.yml \
  --profile genesis-verify up -d --build blob-archive nitro nitro-genesis
```

`blob-archive` fills the pruned April/May Beacon-API gap from Blobscan. Nitro
recomputes every KZG commitment and compares its versioned hash with Ethereum L1;
malformed or substituted blob data stops derivation.

## Monitor

The verification node is host-loopback port `8557`; production remains on `8547`.

```bash
curl -s -H content-type:application/json \
  -d '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
  http://127.0.0.1:8557

docker compose -f docker-compose.yml -f docker-compose.genesis.yml \
  --profile genesis-verify logs --tail=100 nitro-genesis blob-archive
```

During derivation `eth_syncing` returns an object. Promotion requires `false`,
stable operation at the live head, no blob/hash mismatch, and no state/database
errors. On Cadia's constrained memory this is expected to take days, not hours.

## Verify

After `eth_syncing` is `false`:

```bash
NODE_RPC=http://127.0.0.1:8557 \
L1_RPC="$L1_EXECUTION_RPC" \
./verify-snapshot.sh
```

Despite the historical filename, this checks chain identity, recent canonical
block hashes, L1-confirmed assertion anchors, and `debug_traceTransaction`.
For this node, state was independently executed from genesis; the L1-anchored
header/state root is therefore the result of local execution, not imported flat
snapshot state.

Before promotion, compare at least 100 sampled immutable block hashes and state
roots between the two local nodes. Any mismatch is a hard failure.

## Promote

Promotion is a separate reviewed change:

1. Add `http://ophis-rbh-node-verified:8547` to eRPC.
2. Make protected settlement reads 2-of-2 between the two local nodes.
3. Remove `robinhood-official` from mandatory read consensus.
4. Keep the official endpoint only as Nitro's transaction forwarding target and
   an explicitly rate-limited, non-authoritative emergency upstream.
5. Run `assert-erpc-failclosed.py`, Compose security checks, and an end-to-end
   funded canary before accepting user traffic.

Never promote based only on elapsed time or a healthy container status.
