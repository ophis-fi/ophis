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
only `debug_*`/`arbtrace_*` leg in the eRPC 3-of-4 proxy (`../configs/erpc.yaml.tmpl`),
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
   v3.11.2 calls `/eth/v1/beacon/blobs/{slot}` and the `blob_sidecars` fallback was
   REMOVED in v3.10.0, so a provider exposing only `blob_sidecars` (Blobscan,
   base-org/blob-archiver, several provider docs) will NOT satisfy it without a
   translating proxy. Use `--parent-chain.blob-client.beacon-url`, plus
   `--parent-chain.blob-client.secondary-beacon-url` for a fallback. As of 2026-07-21
   no free source of the April-May 2026 blob range was found at all - budget for a paid
   archive-beacon provider and prove its depth with the pre-purchase curl above.
2. **Restore from a database snapshot**, then follow the tip - which reduces the blob
   requirement to hours and lets a free endpoint serve it.
   - Robinhood publishes **no** official snapshot (`--init.url` placeholder left blank).
     Both `robinhood-snapshots.offchainlabs.com` and `snapshot.arbitrum.foundation`
     (Nitro's built-in `--init.latest-base` default) return 404 for 4663, so the
     `--init.latest` mechanism cannot work either. Verified.
   - Ask `chain-developers-group@robinhood.com` for an official one. **Prefer this.**
   - A third-party snapshot exists (`snapshot.titandeployer.com`, ~107 GB compressed /
     ~181 GB extracted, daily, published SHA256, resumable). It is operated
     **anonymously** ("Titan Locker", a token-locking dapp on 4663, Telegram-only, no
     Orbit-infra reputation), and it ships the `wasm` executable directory.

   ### Trusting an untrusted snapshot is HARDER than "check a few block hashes"

   An earlier revision of this runbook said to cross-check block hashes against the public
   RPC. **That is necessary but NOT sufficient**, and the gap is a settlement-integrity
   hole. Verified in the Geth/Nitro source (`core/state/database.go`, `CachingDB.Reader`):
   state reads are served from the **flat snapshot layer first** (`newFlatReader`), and the
   hash-verifying trie reader is only a fallback for gaps. The flat layer hashes the lookup
   **key**, never the returned **value** - so a snapshot with tampered account balances,
   storage slots, or contract code returns **silently wrong** state with no error. Header
   `stateRoot` is not recomputed on a trace read. Consequently:
   - Matching block hashes proves the **header chain** is canonical; it does **not** prove
     the flat state DB behind those headers is faithful. Wrong-not-missing state means the
     eRPC fail-closed guard never trips - the autopilot would trace against corrupt state
     and mis-decode a settlement.
   - The L1 `AssertionConfirmed` (blockHash, sendRoot) anchor is real but only pins headers,
     and only up to ~6 days behind tip; it does not close the flat-state hole.
   - The only sound assurances are: (a) get the snapshot from a **trusted publisher** over
     TLS with an out-of-band checksum (Titan is anonymous, so this fails), or (b) re-derive
     state by executing from DA - which on this chain is exactly what the blob gap makes
     impossible. So an anonymous snapshot is a **reputational bet**, not a verifiable one.
   - If used anyway: keep `--init.import-wasm=false` (default; its own flag help says the
     wasm dir "contains executable code - only use with highly trusted source") and let the
     node rebuild wasm locally; verify the SHA256; and treat every trace as only as
     trustworthy as Titan.

3. **Skip self-hosting entirely (VERIFIED AVAILABLE).** Managed providers already serve
   `debug_traceTransaction` for 4663 today - confirmed on provider docs 2026-07-22:
   [Dwellir](https://www.dwellir.com/docs/robinhood/debug_traceTransaction) (dedicated
   method page, archive + Nitro debug_* namespace),
   [Chainstack](https://docs.chainstack.com/docs/robinhood-methods) (full geth debug_*
   tracer set on mainnet + testnet), and
   [Alchemy](https://www.alchemy.com/rpc/robinhood) (debug_trace on request). Ophis could
   point eRPC at two of these for the 3-of-4 quorum and NOT run this node at all - no
   blobs, no snapshot, no Windows runtime, no from-genesis sync. This sidesteps every
   fatal blocker above.

   **The trade-off is the whole reason the sovereign node exists.** A third-party trace leg
   reintroduces exactly the trust/independence the self-hosted node was meant to remove: you
   are trusting the provider's trace output, and two managed providers can share a failure
   domain (both fail-close Ophis at once). The strongest posture is a hybrid - two managed
   trace providers for availability now, plus the self-hosted node (once snapshot-restored
   and hash-verified) as the sovereign tie-breaker leg. But if the goal is simply "Ophis can
   trace 4663 this week", the managed route is the pragmatic answer and needs no node at all.

## Trace namespaces - the load-bearing flags

The autopilot needs `debug_traceTransaction`, served by the Geth-derived `debug`
namespace. It is not on by default. The node runs with:

```
--http.api=net,web3,eth,debug,arb
```

**Do NOT rely on `arbtrace_*`.** An earlier revision listed the `arbtrace_*` family as
a second tracing option and put `arbtrace` in `--http.api`. Verified against the Nitro
v3.11.2 source (`execution/gethexec/api.go`, `ArbTraceForwarderAPI`): `arbtrace_*` is a
pure **forwarder** to a legacy pre-Nitro "classic" Arbitrum node, not a tracer. Orbit
chains like Robinhood have no classic node, so every `arbtrace_*` call returns
`arbtrace calls forwarding not configured`. Use `debug_traceTransaction` only.

**Archive vs near-tip - archive is NOT needed.** Verified in the Nitro/Geth source: the
default non-archive node keeps recent state in memory per `--execution.caching.block-count`
and `--execution.caching.block-age`, and `debug_traceTransaction` on a near-tip tx is
served from that window without archive. The autopilot only ever traces settlements it
just submitted (seconds old), so the default pruned/full node suffices. Archive
(`--execution.caching.archive`) is disk-heavy (multi-TB) and only needed for tracing OLD
txs; add it solely if just-landed traces start returning "missing trie node" / "state not
available".

**Tracer timeout gotcha.** `debug_traceTransaction` has a hardcoded ~5s default tracer
timeout with no Nitro flag to raise it. A very large CoW settlement trace can exceed it
and return an error, which the fail-closed autopilot reads as "trace unavailable" and
pauses settlement. If that shows up in practice, pass a per-call `timeout` in the tracer
config (e.g. `'{"tracer":"callTracer","timeout":"30s"}'`) from the autopilot rather than
relying on the default.

After the node is synced, prove trace works before wiring it into eRPC:

```bash
# from the eRPC host, over Tailscale:
LATEST=$(cast tx $(cast block latest --rpc-url http://ophis-rbh-node:8547 --json | jq -r '.transactions[0]') --rpc-url http://ophis-rbh-node:8547 --json | jq -r '.hash')
cast rpc debug_traceTransaction "$LATEST" '{"tracer":"callTracer"}' --rpc-url http://ophis-rbh-node:8547 | head
# non-error JSON trace     => autopilot-ready.
# -32601 "method ... not available" / does not exist => `debug` namespace NOT
#                             enabled; fix --http.api and restart.
# "missing trie node" / "state not available" => the tx is older than the near-tip
#                             state window; for a JUST-landed settlement this should
#                             not happen - if it does, the node is lagging or pruned
#                             too aggressively (distinct from -32601; do NOT "fix" it
#                             by editing --http.api).
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
