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
| **L1 beacon (blob) endpoint** | An Ethereum consensus/beacon API (`--parent-chain.blob-client.beacon-url`). Robinhood posts DA as **EIP-4844 blobs** (Rollup mode, NOT AnyTrust), and blobs live on the beacon chain, not the execution layer. | Must reach back to the rollup's deployment - see "From-genesis sync is not possible" below. A standard free beacon API does NOT. One fallback is supported via `--parent-chain.blob-client.secondary-beacon-url`. |
| **Robinhood chain-info JSON** | The Orbit rollup config (`--chain.info-json` or `--chain.info-files`) describing chainId 4663, its rollup/inbox/bridge L1 addresses, and genesis. | Published by Robinhood - see `robinhood-chain-info.md` in this dir. Pull the canonical file from the live docs before deploy; do not hand-transcribe rollup addresses. |

**DA mode is Rollup (blobs), not AnyTrust** - so there is NO DAC / `--node.data-availability.*`
config. If you see AnyTrust flags in a copied Arbitrum runbook, they do not apply here.

---

## From-genesis sync is NOT possible (measured 2026-07-21)

**Read this before provisioning anything.** It is the binding constraint on the whole
deployment, and it is not a hardware problem - a bigger machine does not fix it.

The rollup deployed at Ethereum L1 block `24994238`, timestamp **2026-04-30 16:51:59 UTC**.
Nitro syncs by replaying the chain's DA (EIP-4844 blobs) from that point. Blobs are not
retained forever, so the question is whether any beacon endpoint still serves that era.

Measured against `ethereum-beacon-api.publicnode.com`, sampling consecutive slots
(`/eth/v1/beacon/blobs/{slot}`) and counting how many carry blob data:

| Age | Slots sampled | With blobs |
|---|---|---|
| 82d (rollup deploy) | 10 | **0** |
| 75d | 10 | **0** |
| 70d / 65d / 60d / 55d / 50d | 6 each | **0** |
| 45d | 10 | 6 |
| 3d | 10 | 9 |

So retention on that endpoint is roughly **45-50 days** - and the chain is **82 days old**.
Roughly the **first 32-37 days of DA is unreachable**, and a from-genesis sync stalls there.

Note the ~45-50d figure is specific to that endpoint and to the post-Fusaka era (responses
report `"version":"fulu"`, i.e. PeerDAS data columns). It is NOT the classic ~18-day
`MIN_EPOCHS_FOR_BLOB_SIDECARS_REQUESTS` figure an earlier revision of this runbook quoted,
and it will drift. **Re-measure before every deploy** - the gap widens as the chain ages:

```bash
# '"data":[]' across a run of consecutive slots => that era is gone from this endpoint.
for i in $(seq 0 9); do
  curl -s "$L1_BEACON_URL/eth/v1/beacon/blobs/$((14229224 + i))" | head -c 60; echo
done
```

### The two ways out

1. **An archive beacon provider** whose blob retention reaches past 2026-04-30. Verify with
   the loop above *before paying* - retention depth is rarely advertised accurately. Nitro
   v3.11.2 calls `/eth/v1/beacon/blobs/{slot}`; providers exposing only the older
   `blob_sidecars` API may not satisfy it. Use `--parent-chain.blob-client.beacon-url`, plus
   `--parent-chain.blob-client.secondary-beacon-url` for a fallback.
2. **Restore from a database snapshot**, then follow the tip - which reduces the blob
   requirement to hours and lets a free endpoint serve it.
   - Robinhood publishes **no** official snapshot (`--init.url` placeholder left blank).
     `robinhood-snapshots.offchainlabs.com` does **not** exist (HTTP 404, verified).
   - Ask `chain-developers-group@robinhood.com` for an official one. **Prefer this.**
   - Third-party snapshots exist but are **unattributed**. Treat any such snapshot as
     untrusted input: a Nitro data directory can carry executable wasm. Leave
     `--init.import-wasm` at its default `false`, verify publisher checksums, and - before
     Ophis trusts a single trace from it - cross-check block hashes at several heights
     against `rpc.mainnet.chain.robinhood.com`. Ophis settles real value on these traces;
     a tampered state DB is a settlement-integrity risk, not just an ops inconvenience.

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

**"blob not found" / stalled sync in the early chain range:** the beacon endpoint's blob
retention does not reach back to the rollup deployment. See "From-genesis sync is not
possible" above - this is expected, not a misconfiguration, and no flag fixes it. You need
a deeper archive beacon or a snapshot. Note there is NO
`--parent-chain.blob-client.blob-storage-service-urls` flag (an earlier revision of this
runbook invented it); the real fallback knob is
`--parent-chain.blob-client.secondary-beacon-url`.

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
