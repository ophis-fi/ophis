# Ophis - Robinhood Chain self-hosted Nitro node (WS13-equivalent)

Robinhood Chain (mainnet **chainId 4663 / 0x1237**) is an **Arbitrum Orbit L2** running
the stock **Offchain Labs Nitro** node - NOT an OP-Stack chain. This is the single
biggest divergence from the Optimism / Unichain sovereign playbook: those run
`op-reth` + `op-node`; here we run one `offchainlabs/nitro-node` container.

**Why we self-host at all (same reason as Unichain):** the Ophis autopilot HARD-requires
`debug_traceTransaction` to decode settlement calldata, and it fail-closes (pauses
settlement, never mis-settles) when trace is unavailable. Robinhood's public RPC
(`rpc.mainnet.chain.robinhood.com`) serves `--http.api=net,web3,eth` only - **no
`debug`, no `arb`, no `arbtrace`** (verified by probe 2026-07-02). So the sovereign
stack must run its own Nitro node with the trace namespaces enabled. This node is the
only `debug_*`/`arbtrace_*` leg in the eRPC 2-of-3 proxy (`../configs/erpc.yaml.tmpl`),
plus a read-consensus voter.

The node publishes JSON-RPC on **:8547** (HTTP) and **:8548** (WS). The eRPC proxy in the
main stack reaches it over Tailscale at `ophis-rbh-node:8547`.

---

## Hard prerequisites (these are the real lift)

Unlike an OP-Stack self-node (which only needs an L1 execution RPC + beacon for
op-node), a Nitro node validates the L2 chain by reading its batches and blob data
from Ethereum L1. You MUST supply two L1 endpoints:

| Prereq | What | Free options |
|--------|------|--------------|
| **L1 execution RPC** | An Ethereum mainnet JSON-RPC (`--parent-chain.connection.url`). Nitro reads the SequencerInbox batches from here. | Own Ethereum node (best), or a free-tier provider, or `https://ethereum-rpc.publicnode.com`. |
| **L1 beacon (blob) endpoint** | An Ethereum consensus/beacon API (`--parent-chain.blob-client.beacon-url`). Robinhood posts DA as **EIP-4844 blobs** (Rollup mode, NOT AnyTrust), and blobs live on the beacon chain, not the execution layer. | Own beacon node (best), or a free beacon API. Blobs are retained ~18 days; for a from-genesis re-sync of an older chain you need a blob archiver (`--parent-chain.blob-client.blob-storage-service-urls`). |
| **Robinhood chain-info JSON** | The Orbit rollup config (`--chain.info-json` or `--chain.info-files`) describing chainId 4663, its rollup/inbox/bridge L1 addresses, and genesis. | Published by Robinhood - see `robinhood-chain-info.md` in this dir. Pull the canonical file from the live docs before deploy; do not hand-transcribe rollup addresses. |

**DA mode is Rollup (blobs), not AnyTrust** - so there is NO DAC / `--node.data-availability.*`
config. If you see AnyTrust flags in a copied Arbitrum runbook, they do not apply here.

---

## Trace namespaces - the load-bearing flags

The autopilot needs `debug_traceTransaction`. Nitro serves it via the Geth-derived
`debug` namespace, plus the Arbitrum-native `arbtrace_*` family. Neither is on by
default. The node MUST run with:

```
--http.api=net,web3,eth,debug,arb,arbtrace
```

**Archive vs near-tip.** Full historical tracing (`debug_traceTransaction` on a tx older
than the in-memory state window) requires an **archive** node: `--execution.caching.archive`.
On Nitro/Geth, archive is disk-heavy (Arbitrum One archive is multi-TB with PathDB) -
far more than an equivalent `op-reth` archive. The Ophis autopilot only ever traces
**near-tip** settlements it just submitted (seconds old), so a pruned/full node with the
`debug` namespace and a generous in-memory state-retention window MAY suffice and save
the archive disk. Start pruned + debug-enabled; add `--execution.caching.archive` only if
trace calls on recently-landed settlements start returning "state not available".

After the node is synced, prove trace works before wiring it into eRPC:

```bash
# from the eRPC host, over Tailscale:
LATEST=$(cast tx $(cast block latest --rpc-url http://ophis-rbh-node:8547 --json | jq -r '.transactions[0]') --rpc-url http://ophis-rbh-node:8547 --json | jq -r '.hash')
cast rpc debug_traceTransaction "$LATEST" '{"tracer":"callTracer"}' --rpc-url http://ophis-rbh-node:8547 | head
# a non-error JSON trace => the node is autopilot-ready. An -32601 "method not
# available" => the debug namespace is NOT enabled; fix --http.api and restart.
```

---

## Sync

- **Snapshot / init.** Robinhood publishes **no snapshot URL** (their docs leave the
  `--init.url=<SNAPSHOT_URL>` placeholder unfilled; ask chain-developers-group@robinhood.com).
  So first sync runs from the published genesis file via `--init.genesis-json-file`, per the
  documented mainnet command. An earlier revision of this runbook used `--init.latest=pruned`;
  that is NOT in the documented command and has no snapshot source to resolve against.
  From-genesis sync needs the beacon blob window (or a blob archiver) as noted above, and
  Robinhood warns it "will consume significant L1 request quota" - do not point it at a
  free-tier L1 endpoint.
- **Sequencer feed** for low-latency tip: `--node.feed.input.url=wss://feed.mainnet.chain.robinhood.com`
  (a non-sequencer full node subscribes to the sequencer feed to see txs before the next L1 batch).
- Chain does ~134ms blocks (empirical), so it accrues block height fast (~900k/day). Budget disk.

## Resources (per Robinhood's OWN docs - verified 2026-07-21)

These are materially heavier than the generic Arbitrum guidance an earlier revision
of this runbook quoted (16/32 GB). Size against these, not those:

| | Robinhood docs | (generic Arbitrum guidance) |
|---|---|---|
| RAM | **64 GB min, 128 GB recommended** | 16 min / 32 rec |
| Disk | **NVMe SSD, "several TBs"**; (2 x chain size) + 20% | same formula |
| CPU | **8+ cores** | 4+ cores |

Nitro memory can be capped via `GOMEMLIMIT` + `--node.resource-mgmt.mem-free-limit`
under load, but that trades OOM-safety for sync speed - it does not make a 32 GB box
adequate. Archive (`--execution.caching.archive`) is multi-TB on top of the above.

The chain does ~134ms blocks (~900k/day), so disk grows fast; provision headroom and
alert on free space rather than sizing to today's chain.

---

## Run it

The `docker-compose.yml` in this dir is a starting point (a SEPARATE compose project
from the main stack, mirroring how Unichain runs `/opt/unichain-node` beside the CoW
stack). Fill the two L1 endpoints and the chain-info path, then:

```bash
cd infra/robinhood-mainnet/nitro
cp .env.example .env      # set L1_EXECUTION_RPC, L1_BEACON_URL
# robinhood-chain-info.json + robinhood-genesis.json are already committed here
# (fetched from the Robinhood CDN 2026-07-21); re-pull if upstream revises them.
docker compose up -d
docker compose logs -f nitro   # watch it sync to the tip
```

Then confirm the trace check above passes, expose :8547 to the eRPC host over Tailscale
as `ophis-rbh-node`, and bring up the main stack (`../compose-up.sh`).

---

## Common failures

**Autopilot pauses settlement / `debug_traceTransaction` -32601:** the `debug`/`arb`/`arbtrace`
namespaces are not in `--http.api`. This is the #1 misconfig. Fix and restart.

**Node stuck / not advancing past a block:** almost always the L1 execution RPC or the L1
beacon endpoint is down or rate-limited - Nitro cannot read new batches / blobs. Check both
L1 legs first.

**"blob not found" during from-genesis sync:** the beacon endpoint's blob retention window
(~18 days) does not cover the range. Use a blob archiver
(`--parent-chain.blob-client.blob-storage-service-urls`) or an `--init` snapshot past that range.

**Wrong chain / genesis mismatch:** the chain-info JSON is stale or hand-edited. Re-pull the
canonical file (`robinhood-chain-info.md`); never transcribe rollup/inbox addresses by hand.

---

## What this replaces vs the OP-Stack playbook

| | OP-Stack (Unichain) | Arbitrum Orbit (Robinhood) |
|---|---|---|
| Daemon(s) | `op-reth` + `op-node` (2 processes) | `offchainlabs/nitro-node` (1 process) |
| L1 needs | L1 execution RPC + L1 beacon (op-node) | L1 execution RPC + L1 beacon (Nitro, blob DA) |
| Trace | native op-reth `debug` namespace, disk-cheap archive | `debug` + `arbtrace_*`, archive is disk-HEAVY |
| Config | rollup config baked into op-node | `--chain.info-json` Orbit rollup config |
| eRPC leg host | `ophis-uni-node:8545` | `ophis-rbh-node:8547` |
