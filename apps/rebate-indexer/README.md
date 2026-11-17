# @ophis/rebate-indexer

Off-chain indexer + Safe batch proposer for Ophis's volume-tiered WETH rebate program.

## Quickstart (dev)

```bash
pnpm install
docker compose up -d pg
pnpm db:migrate
pnpm dev
```

## Architecture

See [`docs/development/specs/2026-05-11-rebate-ledger-design.md`](../../docs/development/specs/2026-05-11-rebate-ledger-design.md).

## Runbook

See [`RUNBOOK.md`](./RUNBOOK.md) for incident response.

See the [Ethereum RPC runbook](../../infra/ethereum-rpc/README.md) for baal-backed
chain-1 reads, public fallback, and the scheduled OTC consistency check.

## Business console read route

`POST /business/partner` lets the Ophis Business console read the partner-fee
dashboard of up to 10 wallets per call. With it comes `traders`: the wallets
that traded through that partner's integration (the trades that carried its
fee), each with its trades and USD volume. It lists the 100 largest, and its
totals count every wallet. A sale of native ETH is listed under the wallet
that paid, when the indexer attributed one to the settlement; while an
eth-flow contract still owns it, it counts in `unknown`, never as a wallet.
Each fill records where its wallet came from (`user_source`: `owner`,
`onchain_user` or `receiver`). A native-ETH sale is named by its wallet only
when the fill is verified and that wallet is the payer (`onchain_user`, CoW's
record of who paid the ETH). Any other eth-flow fill stays in `unknown`: the
on-chain decoder and older API records see only the order's receiver, which
the order's maker chooses. Such trades are not checked against the sanctions
lists, and the console says so. Fills written before migration 0051 have no
source yet: the nightly pipeline asks CoW for up to 100 of those orders per
run and records the source when the stored wallet is the payer or the
receiver. A row CoW cannot answer for stays in `unknown`. A recorded payer is
never replaced by a later verified write that does not name it.
It does not read the referral
dashboard: the console's partners get no referral share (`POST /partner` keeps
it for retail). It is gated by `BUSINESS_API_TOKEN`
(`Authorization: Bearer ...`). This token reads EVERY partner's fee dashboard
and traders, so it is a secret: at least 32 characters, and different from
`REBATE_INDEXER_ADMIN_TOKEN`. Unset, too short, or equal to the admin token
means the route is off (404 for every caller).

The body is `{ wallets, contract, listed }`, all three required. `listed` holds
the addresses on the sanctions lists the console has loaded (`[]` when none is
loaded): each wallet's answer names those of them that traded through its
integration. `contract` names each wallet the console
proved by a contract signature (a Safe), with the chains it proved it on. Such
a wallet is read only when one of those chains is its pinned chain in
`CONTRACT_WALLET_AUTH_CHAINS`, the rule `POST /partner` applies: the same
address on another chain can be a contract with other owners. Otherwise its
entry is `{ wallet, fees: null, traders: null }` and nothing is read for it. A wallet
proved by its own key is not listed and is read on any chain.

To turn the route on, set `BUSINESS_API_TOKEN` in the host environment of the
deploy: `docker-compose.yml` passes it to the indexer process. Leave it unset
and the route stays off.

## GitHub secrets required for deploy

The deploy workflow joins the tailnet as an ephemeral `tag:ci` node and builds
the Docker image on Cadia via `docker compose up --build`, so no container
registry credential is required. Configure these secrets in the `Production`
GitHub environment:

| Secret | Source | Notes |
|---|---|---|
| `TS_OIDC_CLIENT_ID` | Tailscale OIDC workload identity credential | OAuth client ID |
| `TS_OIDC_AUDIENCE` | Tailscale OIDC workload identity credential | audience configured for the trust credential |
| `CADIA_REBATES_SSH_PRIVATE_KEY` | dedicated deploy key | private half of the key whose public half is in Cadia's `~/.ssh/authorized_keys` |
| `CADIA_REBATES_SSH_HOST` | `tailscale ip -4` on Cadia | Cadia's Tailscale IPv4 address; the SSH listener is bound only to this address |
| `CADIA_REBATES_SSH_USER` | Cadia operator configuration | unprivileged deploy user with access to `/srv/ophis` and Docker |
| `CADIA_REBATES_SSH_PORT` | Cadia sshd configuration | tailnet-only deploy listener port (`2222` currently) |
| `CADIA_REBATES_SSH_HOST_KEY` | `ssh-keyscan -p <port> <host>` over Tailscale | complete pinned `known_hosts` line, including `[host]:port` |

In Tailscale, create an OpenID Connect trust credential with issuer
`https://token.actions.githubusercontent.com`, subject
`repo:ophis-fi/ophis:environment:Production`, scope `auth_keys:write`, and tag
`tag:ci`. The tailnet policy needs `tagOwners` for `tag:ci` and an access rule
allowing `tag:ci` to reach only `100.85.130.25` on TCP port `2222`.

The `.env` file on the VM is **not** synced by the deploy workflow — it lives at
`/srv/ophis/apps/rebate-indexer/.env` and is managed out-of-band (operator updates
it via `ssh` when secrets rotate). The workflow's `rsync --delete` explicitly
excludes it.

## Contract-wallet authentication

The five signed affiliate/partner/reward endpoints accept EIP-1271 signatures only
on an operator-pinned chain for each global wallet identity. Set
`CONTRACT_WALLET_AUTH_CHAINS` to a JSON object mapping **lowercase wallet addresses**
to numeric supported chain IDs after confirming the authoritative deployment with
the wallet administrator. Do not infer authority from the request, from a matching
address on another chain, or from the first successful signature.

For example, `{"0x1111111111111111111111111111111111111111":1}` pins that example
contract to Ethereum. Missing/invalid configuration fails closed for contract
wallets; existing EOA signatures are unaffected. A Safe owner rotation must be
checked on this pinned chain. Changing the pin is an operator-controlled identity
change and requires renewed verification. Payouts remain separately disabled.

## Swap scan (exhaustive, allowlist-free)

Report every Ophis swap in a time window across chains, independent of the rebate
wallet allowlist. Read-only: it never touches the rebate DB.

```bash
# All 14 production chains, last 48h, also DM Clement:
pnpm scan --since 48h --telegram

# one chain, custom window, custom artifact path:
pnpm scan --since 2d --chains ethereum --json /tmp/eth.json

# override a public endpoint (or set ALCHEMY_API_KEY for supported chains):
SCAN_RPC_ETHEREUM=https://example-rpc.invalid pnpm scan --since 2d --chains ethereum
```

Discovery is on-chain (`getLogs(Trade)` on the CoW Settlement contract) plus per-order
appData resolution via CoW's API, keeping `appCode in {ophis, greg}`. Self-hosted
Optimism and Arc read their local orderbook Postgres directly (run on the Mac mini where Docker
lives). RPC chains use keyless public endpoints by default; `SCAN_RPC_<CHAIN>` overrides
one endpoint, while `SCAN_BLOCK_RPC_<CHAIN>` can separately override historical block
headers when a log provider does not serve them. An explicitly set `ALCHEMY_API_KEY`
takes precedence over the public fallback on supported chains. The optional `ophis-telegram-bot` secret comes from the
macOS Keychain. The JSON artifact and the orderUid cache default to `~/.ophis/` (out of repo). Design:
`docs/development/specs/2026-06-19-onchain-appdata-swap-scan-design.md`.

Arc uses chain ID `5042`, `https://arc-mainnet.ophis.fi`, and settlement
`0x78799f98276efba1edeed32eae03a3fd8cdfec3a`. Its USD reference is the **6-decimal
ERC-20 USDC** at `0x3600000000000000000000000000000000000000`, not the 18-decimal
native gas balance. Historical reporting prices use the verified `arc` coins-API
namespace. Arc keeps the sovereign 100% fee fraction; its backend has no operator
improvement prefix. This integration does not enable Arc own-fee payouts.
