# Optimism Mainnet Follower Node — `op-node` + `op-reth`

Self-hosted Optimism mainnet (chain ID **10**) JSON-RPC endpoint. Two containers
on a single Debian 12 host, no sequencer/batcher/proposer keys — read-only
follower only. Exposes `eth_*`, `net_*`, `web3_*`, `debug_*`, `txpool_*` over
HTTP `:8545` and WS `:8546`, bound to `127.0.0.1`. Engine API (`engine_*`)
lives on the JWT-authenticated port `:8551`, internal to the compose network.

Downstream consumer: the CoW Protocol services stack on a separate host
(reaches this node over Tailscale).

---

## Why op-reth and not op-geth

OP Labs migrated their official snapshot distribution to **op-reth** in 2026 —
op-geth snapshots are no longer published. Beyond that, op-reth is:

- **More memory-efficient.** 10 GB container limit is comfortable where
  op-geth wanted 12 GB.
- **Faster on EVM execution.** revm + JIT optimisations beat geth on a
  per-block basis.
- **MDBX-backed** (single B+ tree) instead of LevelDB — fewer pathological
  compaction stalls and a more compact on-disk footprint.
- The flag set is intentionally **closer to geth than not**, but a handful of
  things moved: no `--syncmode`, sync mode is `--full` (default = archive);
  no `--http.vhosts` (geth-only); `--rollup.sequencer-http` (hyphenated, vs
  geth's `--rollup.sequencerhttp`); `--metrics` takes a single `addr:port`
  argument.

---

## 1. Host requirements

| Resource | This deployment | Notes |
|---|---|---|
| OS | Debian 12 | Anything modern with Docker Engine 24+ works |
| CPU | 8 vCPU | Reth saturates ~4 cores during snapshot import |
| RAM | 14 GB | `op-reth` capped at 10 GB, `op-node` at 2 GB |
| Disk | 1.1 TB NVMe | Snapshot extracted ≈ 1.0 TB; ~100 GB headroom |
| Network | 1 Gbit/s + | Snapshot is 617 GB compressed |
| Docker | 24.0+ | `docker compose` v2 plugin |

Install once:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg openssl zstd
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"
# log out / back in for the group change to apply
```

---

## 2. One-time setup

From this directory (`infra/optimism/node/`):

```sh
# (a) Engine-API JWT secret — shared between op-node and op-reth.
#     Must be exactly 32 bytes (64 hex chars). Both containers mount it RO.
openssl rand -hex 32 > jwt.hex
chmod 640 jwt.hex

# (b) Environment file
cp .env.example .env
$EDITOR .env   # fill in OP_NODE_L1_ETH_RPC and OP_NODE_L1_BEACON

# (c) Chain data dir (will be populated by snapshot in step 3)
mkdir -p reth-data
```

### Where the JWT lives

- File: `infra/optimism/node/jwt.hex` (this directory, host side).
- Mount: both `op-reth` and `op-node` read it as `/jwt.hex` (read-only bind).
- Permissions: `640` is fine — the Docker daemon reads it as root.
- **Never commit.** It is in `.gitignore`. If it leaks, regenerate it and
  restart both containers (mismatched JWT → `op-node` can't talk to `op-reth`,
  expect `engine_forkchoiceUpdated ... unauthorized` in the op-node logs).

### L1 RPC choice — be deliberate

`op-node` needs **two** L1 endpoints:

1. **Execution-layer RPC** (`OP_NODE_L1_ETH_RPC`) — standard `eth_*` JSON-RPC.
2. **Consensus-layer Beacon REST** (`OP_NODE_L1_BEACON`) — mandatory since
   the Ecotone upgrade (Mar 2026), because batches now live in EIP-4844 blob
   sidecars, not calldata. **If you skip this, the node will silently stall
   the first time it hits an Ecotone block.** Many old tutorials omit it.

The defaults in `.env.example` (`ethereum-rpc.publicnode.com` +
`ethereum-beacon-api.publicnode.com`) worked reliably in production testing
on 2026-05-12.

Avoided: `eth.llamarpc.com` (Cloudflare-blocked our Aleph VM egress IP →
503 on every request) and `www.lightclientdata.org` (intermittent 503s
during initial sync). Both are listed in `.env.example` for completeness
but are not the default.

For production, point at a paid provider (Alchemy / Infura / dRPC paid)
or your own self-hosted L1 geth + lighthouse pair if uptime matters more
than cost.

---

## 3. Snapshot bootstrap (mandatory)

Syncing op-reth from genesis takes weeks. **You must** start from the
official OP Labs snapshot.

**Snapshot URL (pinned 2026-05-04 full node archive):**

```
https://datadirs.optimism.io/mainnet-reth-full-2026-05-04.tar.zst
```

**SHA-256:** `43cbdecc1cbb7b324e50dce8dd894a1a6d91ceb47e3a481f791815c025fe97b0`

**Sizes:**

- Compressed (download): **617 GB** (≈ 575 GiB)
- Decompressed (on disk): **≈ 1.0 TB**

On a 1.1 TB NVMe this leaves ~100 GB headroom. **Do not** download to disk
then extract — you'll need 1.6 TB peak and run out of space. Stream-extract
in one pass:

```sh
cd infra/optimism/node

# (a) Pre-flight: confirm enough space, install zstd if needed.
df -B1 . | awk 'NR==2 { if ($4 < 1.05e12) { print "FAIL: <1.05 TB free"; exit 1 } else print "OK: " $4/1e9 " GB free" }'
sudo apt-get install -y zstd  # if not already present

# (b) Download just the SHA file first, verify our pinned hash matches.
curl -fsSL -O https://datadirs.optimism.io/mainnet-reth-full-2026-05-04.tar.zst.sha256sum
grep -q '^43cbdecc1cbb7b324e50dce8dd894a1a6d91ceb47e3a481f791815c025fe97b0  ' \
  mainnet-reth-full-2026-05-04.tar.zst.sha256sum \
  || { echo 'FAIL: SHA file does not match pinned hash — snapshot may have been rotated'; exit 1; }

# (c) Stream + verify + decompress + extract, all in one pass.
#     Tee the compressed stream into sha256sum for online verification while
#     piping the rest into zstd | tar. No intermediate 617 GB file on disk.
SNAPSHOT_URL=https://datadirs.optimism.io/mainnet-reth-full-2026-05-04.tar.zst
EXPECTED_SHA=43cbdecc1cbb7b324e50dce8dd894a1a6d91ceb47e3a481f791815c025fe97b0

mkdir -p reth-data
( curl -fL "$SNAPSHOT_URL" \
    | tee >(sha256sum > /tmp/reth-snapshot.sha256) \
    | zstd -d \
    | tar -xvf - -C reth-data ) \
  && grep -q "^$EXPECTED_SHA " /tmp/reth-snapshot.sha256 \
  && echo "OK: snapshot extracted and SHA verified" \
  || { echo "FAIL: download or SHA mismatch — wipe reth-data and retry"; exit 1; }

# (d) Sanity check — the archive should drop db/ and static_files/ subdirs.
ls -la reth-data
du -sh reth-data
```

Expect **3–8 h** to download + decompress on a 1 Gbit/s link, CPU-bound
on `zstd -d` (single-threaded; use `zstd -d -T0` if your zstd build
supports parallel decompression — the v1.5+ Debian package does).

If your link is flaky and you'd rather download once, verify, then extract:

```sh
curl -fL -O "$SNAPSHOT_URL"
sha256sum -c mainnet-reth-full-2026-05-04.tar.zst.sha256sum
zstd -d --stdout mainnet-reth-full-2026-05-04.tar.zst | tar -xvf - -C reth-data
rm mainnet-reth-full-2026-05-04.tar.zst   # free the 617 GB before extract finishes filling 1 TB
```

…but you need 1.6 TB peak for that path. **Stream-extract is the
recommended flow on this 1.1 TB host.**

---

## 4. Bring-up

```sh
docker compose up -d
docker compose ps
docker compose logs -f op-reth
```

You're watching for these milestones in order:

1. **op-reth starts** — `Starting reth ... chain=optimism`, then
   `Opened database ... path=/data` and `Engine API server started`.
2. **EL catch-up from snapshot tip** — `Imported block ... number=...` lines,
   head advancing toward the current OP head. Snapshot was taken
   2026-05-04, so expect a multi-day delta to fill on first boot.
3. **Healthcheck passes** — `op-reth` flips to `(healthy)` in
   `docker compose ps`. This unblocks `op-node`.
4. **op-node attaches** — in `docker compose logs -f op-node`, look for
   `Engine API ... connected` and `Derivation pipeline ... started`.
5. **Catch-up** — `op-node` advances L2 head. `L1 head` and `L2 unsafe head`
   numbers tick up in the logs.
6. **Synced to head** — `eth_syncing` on `:8545` returns `false`, and the
   block number matches https://optimistic.etherscan.io head within ~2 s.

Expect **4–12 h** after snapshot import to fully catch up to head,
depending on how stale the snapshot was at first boot.

---

## 5. Verify sync

```sh
# Are we syncing? (false = caught up)
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}' \
  http://127.0.0.1:8545 | jq

# Current L2 head
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://127.0.0.1:8545 | jq -r .result | xargs printf "%d\n"

# Chain ID — must be 10 (0xa)
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  http://127.0.0.1:8545 | jq

# op-node's view of safe/unsafe/finalized heads
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"optimism_syncStatus","params":[],"id":1}' \
  http://127.0.0.1:9545 | jq
```

Cross-check the block number against the public Etherscan head; less than
3 blocks (≈6 s) behind is healthy steady state.

---

## 6. Day-2 operations

```sh
# Tail both services
docker compose logs -f --tail=200

# Restart a single service
docker compose restart op-node
docker compose restart op-reth

# Pull newer pinned image versions (edit docker-compose.yml first)
docker compose pull
docker compose up -d

# Stop the stack
docker compose down

# Stop + wipe chain data (DESTRUCTIVE — forces re-snapshot)
docker compose down
sudo rm -rf reth-data
```

### Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `FAIL: SHA file does not match pinned hash` during snapshot fetch | OP Labs rotated the snapshot URL; the 2026-05-04 archive no longer hosted | Check https://datadirs.optimism.io/ for the current `mainnet-reth-full-YYYY-MM-DD.tar.zst`, update the URL + SHA in this README, re-run |
| `bind: address already in use` on `8545` | Another service (rpc forwarder, anvil, hardhat) is on the port | `sudo ss -tlnp \| grep :8545` to identify it; stop it or pick a different host port in the `ports:` mapping |
| op-reth panics with `chain mismatch` or `invalid genesis` | Snapshot was for the wrong network (sepolia, base) or partial extraction | `docker compose down && sudo rm -rf reth-data && mkdir reth-data` and re-run the snapshot bootstrap |
| op-node logs `engine_forkchoiceUpdated ... unauthorized` | JWT mismatch between containers | `docker compose down`, regenerate `jwt.hex` (step 2a), `docker compose up -d` |
| op-node stalls / 503s from L1 follow-RPC | `OP_NODE_L1_ETH_RPC` or `OP_NODE_L1_BEACON` rate-limited or down | Swap to a different provider in `.env`, `docker compose restart op-node` |
| op-reth: `mdbx: error: concurrent transactions` after a few minutes | Container PID namespace bug | The `pid: host` directive in `docker-compose.yml` fixes this; if you removed it, restore it |

### Resource monitoring

Prometheus scrape endpoints (already exposed inside the compose network):

- op-reth: `http://127.0.0.1:9001/` (reth serves Prometheus on the root path)
- op-node: `http://127.0.0.1:7300/metrics`

---

## 7. Exposing the RPC to consumer hosts via Tailscale

The compose file binds `8545` / `8546` / `9545` to `127.0.0.1` only. To let
another tailnet host (e.g. the CoW services VM) reach them, expose them on
the Tailscale interface via host `iptables` — **not** by changing the
compose `ports:` to `0.0.0.0`.

This is its own runbook — see the separate Tailscale doc. Sketch:

1. `tailscale up` on this host, note the `100.x.y.z` IP.
2. `iptables -t nat -A PREROUTING -d $TS_IP -p tcp --dport 8545 -j DNAT --to-destination 127.0.0.1:8545`
3. Persist with `iptables-persistent`.
4. Verify with `sudo ss -tlnp | grep 8545` — should still show
   `127.0.0.1:8545` only (DNAT happens pre-bind).

---

## 8. File inventory

```
infra/optimism/node/
├── docker-compose.yml    # two-service stack, pinned image tags
├── .env.example          # template — copy to .env
├── .env                  # local config, gitignored
├── .gitignore            # ignores jwt.hex, .env, reth-data/
├── jwt.hex               # shared engine-API secret, gitignored
├── reth-data/            # op-reth chain data, gitignored, ~1.0 TB
└── README.md             # this file
```

Pinned versions (verified 2026-05-12):

- `op-reth`: `v1.10.2` — `ghcr.io/paradigmxyz/op-reth:v1.10.2` (latest stable
  non-rc tag; v1.10.x is the supported line as of this snapshot)
- `op-node`: `v1.18.0` —
  `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.18.0`

Bump both together when a new release lands. op-node / op-reth majors are
loosely coupled but a fork activation can require both to be bumped in
lock-step — check the release notes.
