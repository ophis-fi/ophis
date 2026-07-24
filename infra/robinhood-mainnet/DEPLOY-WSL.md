# Deploying the Robinhood (4663) stack on Windows + WSL2

The stack was authored for a macOS/colima host; this file captures the WSL/Linux-specific
steps needed to run it on this Windows 11 + WSL2 (Ubuntu-24.04) box. Everything else follows
the main `README.md`.

## What the port changed
- **Line endings.** All `*.sh`/`*.py` are pinned to **LF** via `.gitattributes` and the blobs
  were renormalized. CRLF makes bash fail on the shebang (`bash\r`) inside WSL. Checkout on
  Windows now keeps them LF (`core.autocrlf` no longer re-CRLFs them) — no manual `dos2unix`.
- **Secrets source.** macOS reads the Telegram bot token and the inter-service auth token from
  the **Keychain**. On Linux/WSL there is no Keychain, and the macOS `security` calls are
  Darwin-guarded so they never run here:
  - `render-configs.sh` reads `TELEGRAM_BOT_TOKEN` from `secrets/telegram-token` (chmod 600,
    gitignored) if present, else from `.env`.
  - `compose-up.sh` reads `OPHIS_INTER_SERVICE_AUTH_TOKEN` from `.env`.

## Prerequisites (verified present on this box, 2026-07-23)
- WSL2 Ubuntu-24.04, Docker Engine in-distro, `clement` in the `docker` group.
- **Passwordless sudo** for `clement` — required for the tmpfs PK RAM-disk mount, the sudo PK
  read, and the alertmanager token chown to `nobody`.
- `envsubst` (gettext-base), `jq`, `zstd`, `python3` + `python3-yaml`.
- For the deploy ceremony only: **foundry/cast** (`curl -L https://foundry.paradigm.xyz | bash`).

## Deploy steps (after the on-chain ceremony has produced the contract addresses)
1. **Driver user + PK** (Tier-1 isolation):
   ```bash
   cd infra/robinhood-mainnet
   ./scripts/setup-ophis-driver-user.sh      # Linux branch: useradd --system ophis-driver
   # history-safe: the key is typed at the prompt, never on the command line,
   # so it does not land in shell history (unlike `echo '0x...' | ...`).
   read -rs PK; printf '%s' "$PK" | sudo install -m 600 -o ophis-driver -g ophis-driver \
     /dev/stdin /home/ophis-driver/.config/submitter.key; unset PK
   ```
2. **Secrets**: `cp .env.example .env && chmod 600 .env`, fill provider keys (note:
   `ALCHEMY_API_KEY` is the **bare key**, not the full URL — the template prepends
   `https://.../v2/`), CoinGecko key, inter-service token. For alerting:
   `mkdir -p secrets && printf '%s' '<bot-token>' > secrets/telegram-token && chmod 600 secrets/telegram-token`.
3. **Fill contract addresses**: replace every `__FILL_AFTER_DEPLOY_*__` in `configs/*.tmpl`
   (SETTLEMENT, BALANCES, SIGNATURES, ETHFLOW, HOOKS, SUBMITTER_EOA) — see `FILL-IN-AFTER-DEPLOY.md`.
4. **Render + bring up**:
   ```bash
   ./render-configs.sh    # mounts a tmpfs RAM-disk for the PK-bearing driver.toml, renders the rest
   ./compose-up.sh        # builds the Rust backend images + brings up the stack
   ```

## eRPC ↔ node wiring on this box
The Nitro node publishes `:8547` on **127.0.0.1 only**, so the compose `host-gateway` mapping
(and the Tailscale path) cannot reach it here. The working same-box wiring is a shared docker
network, container-to-container:
```bash
docker network create ophis-rbh-net
docker network connect --alias ophis-rbh-node ophis-rbh-net robinhood-nitro-nitro-1
```
This is now **baked into both compose files**: the nitro service joins `ophis-rbh-net` with the
alias `ophis-rbh-node`, and the main-stack `rpc-proxy` joins it (replacing the old broken
`host-gateway` mapping). `compose-up.sh` and `keepalive-node.sh` create the network idempotently,
so it survives reboots and force-recreates with **no manual `docker network connect`**. (The
interim `docker run` proxy `ophis-rbh-rpc-proxy` also sits on this network; when the full stack
deploys, the compose-managed `rpc-proxy` replaces it.)

## Verified on WSL (2026-07-23)
`render-configs.sh` runs clean end-to-end here (tmpfs RAM-disk mounted, PK-on-RAM-disk symlink,
all TOMLs + `erpc.yaml` rendered, observability token chowned to `nobody`). `docker compose
config` parses/interpolates every service. The full `compose-up.sh` build/up is gated on the
on-chain deploy ceremony — the placeholder contract addresses fail closed until filled.
