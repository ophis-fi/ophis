# Optimism Mainnet Follower Node — `op-node` + `op-geth`

Self-hosted Optimism mainnet (chain ID **10**) JSON-RPC endpoint. Two containers
on a single Debian 12 host, no sequencer/batcher/proposer keys — read-only
follower only. Exposes `eth_*`, `net_*`, `web3_*`, `debug_*`, and `engine_*`
over HTTP `:8545` and WS `:8546`, bound to `127.0.0.1`.

Downstream consumer: the CoW Protocol services stack on a separate host
(reaches this node over Tailscale).

---

## 1. Host requirements

| Resource | Minimum | Notes |
|---|---|---|
| OS | Debian 12 | Anything modern with Docker Engine 24+ works |
| CPU | 4 vCPU | Snap-sync is CPU-heavy for ~12 h |
| RAM | 16 GB | `op-geth` configured for `cache=4096` + 12 GB limit |
| Disk | 1 TB NVMe | Mainnet chain is ~700 GB and growing |
| Network | 100 Mbit/s + | Snap snapshot pull + L1 follow |
| Docker | 24.0+ | `docker compose` v2 plugin |

Install once:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg openssl
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
# (a) Engine-API JWT secret — shared between op-node and op-geth.
#     Must be exactly 32 bytes (64 hex chars). Both containers mount it RO.
openssl rand -hex 32 > jwt.hex
chmod 640 jwt.hex

# (b) Environment file
cp .env.example .env
$EDITOR .env   # fill in OP_NODE_L1_ETH_RPC and OP_NODE_L1_BEACON

# (c) Chain data dir (will be populated by snapshot in step 3)
mkdir -p geth-data
```

### Where the JWT lives

- File: `infra/optimism/node/jwt.hex` (this directory, host side).
- Mount: both `op-geth` and `op-node` read it as `/jwt.hex` (read-only bind).
- Permissions: `640` is fine — the Docker daemon reads it as root.
- **Never commit.** It is in `.gitignore`. If it leaks, regenerate it and
  restart both containers (mismatched JWT → `op-node` can't talk to `op-geth`).

### L1 RPC choice — be deliberate

`op-node` needs **two** L1 endpoints:

1. **Execution-layer RPC** (`OP_NODE_L1_ETH_RPC`) — standard `eth_*` JSON-RPC.
2. **Consensus-layer Beacon REST** (`OP_NODE_L1_BEACON`) — mandatory since
   the Ecotone upgrade (Mar 2026), because batches now live in EIP-4844 blob
   sidecars, not calldata. **If you skip this, the node will silently stall
   the first time it hits an Ecotone block.** Many old tutorials omit it.

Free public options are listed in `.env.example`. For production, point at
a paid provider (Alchemy / Infura / dRPC paid) or your own self-hosted L1
geth + lighthouse pair. A simple HAProxy / nginx in front, round-robining
two free providers, gives reasonable redundancy without paying.

---

## 3. Snapshot bootstrap (strongly recommended)

Syncing op-geth from genesis takes weeks. Optimism publishes regular
snapshot archives — pull one and untar into `geth-data/` before first
`docker compose up`.

- Official snapshot index + instructions:
  https://docs.optimism.io/operators/node-operators/management/snapshots
- Alternative mirrors (community-maintained, check checksum):
  https://kb.optimism.io/docs/operators/node-operators/configuration/base-config

Expect: **~700 GB compressed**, **~12–24 h** to download + decompress +
catch-up to head on a 1 TB NVMe / 100 Mbit link.

Rough recipe (adjust URL / filename to whatever the snapshot index points
at on the day):

```sh
cd infra/optimism/node/geth-data

# Example — replace SNAPSHOT_URL with the current archive from the docs.
SNAPSHOT_URL="https://datadirs.optimism.io/mainnet-bedrock.tar.zst"

# Stream + decompress + extract in one pass (avoids 700 GB intermediate file).
curl -fL "$SNAPSHOT_URL" \
  | zstd -d \
  | tar -xvf -

# Sanity check — should contain a `geth/` subdir (chaindata, nodes, etc).
ls -la
du -sh geth
```

If you're behind a flaky link, download to disk first and verify the
checksum the index page publishes before extracting.

---

## 4. Bring-up

```sh
docker compose up -d
docker compose ps
docker compose logs -f op-geth
```

You're watching for these milestones in order:

1. **op-geth starts** — `Started P2P networking ... chain_id=10`.
2. **Snapshot import done** — `Imported new chain segment` lines, head
   advancing toward current Optimism head.
3. **Healthcheck passes** — `op-geth` flips to `(healthy)` in
   `docker compose ps`. This unblocks `op-node`.
4. **op-node attaches** — in `docker compose logs -f op-node`, look for
   `Engine API ... connected` and `Derivation pipeline ... started`.
5. **Catch-up** — `op-node` advances L2 head. `L1 head` and `L2 unsafe head`
   numbers tick up in the logs.
6. **Synced to head** — `eth_syncing` on `:8545` returns `false`, and the
   block number matches https://optimistic.etherscan.io head within ~2 s.

Expect another **4–8 h** after snapshot import to fully catch up to head,
depending on how stale the snapshot was.

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
docker compose restart op-geth

# Pull newer pinned image versions (edit docker-compose.yml first)
docker compose pull
docker compose up -d

# Stop the stack
docker compose down

# Stop + wipe chain data (DESTRUCTIVE — forces full resync)
docker compose down
sudo rm -rf geth-data
```

### Common failures

| Symptom | Cause | Fix |
|---|---|---|
| op-node logs `engine_forkchoiceUpdated ... unauthorized` | JWT mismatch | Regenerate `jwt.hex`, `docker compose down && up -d` |
| op-node stalls at a fixed L2 block, no error | Missing / wrong `OP_NODE_L1_BEACON` post-Ecotone | Set a real beacon REST URL, restart op-node |
| op-geth `database contains incompatible genesis` | Snapshot from a different network (sepolia, base) | Wipe `geth-data/`, re-pull the mainnet snapshot |
| op-geth healthcheck never passes | Snap-sync still importing | Be patient — first import is 12–24 h |
| `eth_syncing` returns object forever | L1 RPC is rate-limited or unreliable | Swap `OP_NODE_L1_ETH_RPC` to a different provider |

### Resource monitoring

Prometheus scrape endpoints (already exposed inside the compose network):

- op-geth: `http://127.0.0.1:6060/debug/metrics/prometheus`
- op-node: `http://127.0.0.1:7300/metrics`

---

## 7. Exposing the RPC to the chain-stack host (vm4) via Tailscale

The compose file binds `8545` / `8546` / `9545` to `127.0.0.1` only. To let
vm4 reach them, expose them on the Tailscale interface — **not** `0.0.0.0`.

High-level (full Tailscale runbook is separate):

1. Install Tailscale on this host: `curl -fsSL https://tailscale.com/install.sh | sh`
2. `sudo tailscale up --hostname=op-node-vm`
3. Note the tailnet IP, e.g. `100.x.y.z`.
4. Add an iptables rule that DNATs `100.x.y.z:8545 → 127.0.0.1:8545`:

   ```sh
   TS_IP=$(tailscale ip -4)
   sudo iptables -t nat -A PREROUTING -d "$TS_IP" -p tcp --dport 8545 \
     -j DNAT --to-destination 127.0.0.1:8545
   sudo iptables -t nat -A PREROUTING -d "$TS_IP" -p tcp --dport 8546 \
     -j DNAT --to-destination 127.0.0.1:8546
   sudo iptables -A INPUT -i tailscale0 -p tcp \
     --match multiport --dports 8545,8546 -j ACCEPT
   sudo apt-get install -y iptables-persistent
   sudo netfilter-persistent save
   ```

5. On vm4, point the chain stack at `http://100.x.y.z:8545`.
6. Do **not** open 8545 on the public NIC. Verify with
   `sudo ss -tlnp | grep 8545` — should show `127.0.0.1:8545` only (the
   iptables DNAT happens before the bind check).

---

## 8. File inventory

```
infra/optimism/node/
├── docker-compose.yml    # two-service stack, pinned image tags
├── .env.example          # template — copy to .env
├── .env                  # local config, gitignored
├── .gitignore            # ignores jwt.hex, .env, geth-data/
├── jwt.hex               # shared engine-API secret, gitignored
├── geth-data/            # op-geth chain data, gitignored
└── README.md             # this file
```

Pinned versions (verified against
https://github.com/ethereum-optimism/optimism/releases and
https://github.com/ethereum-optimism/op-geth/releases on 2026-05-12):

- `op-node`: `v1.18.0`
- `op-geth`: `v1.101702.2`

Bump both together when a new release lands; mismatched majors have caused
derivation breaks in the past.
