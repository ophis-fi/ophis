# `<chain>.ophis.fi` — chain backend runbook (Spec 1)

## SSH

```bash
ssh -i ~/.ssh/aleph-greg -p 24014 root@45.144.209.26
```

Co-tenants on this VM (don't disturb each other):

- `apps/rebate-indexer/` at `/srv/ophis/apps/rebate-indexer/` — public `rebates.ophis.fi`, on host port 8080
- `infra/optimism/` at `/srv/ophis/infra/optimism/` — public `optimism-sepolia.ophis.fi`, on host port 8100
- `infra/megaeth/` at `/srv/ophis/infra/megaeth/` — public `megaeth-testnet.ophis.fi`, on host port 8082

## Logs

Per-container, last 100 lines:

```bash
docker logs --tail 100 optimism-orderbook-1
docker logs --tail 100 optimism-driver-1
# autopilot, baseline, db similarly named
```

cloudflared logs:

```bash
journalctl -u cloudflared-optimism-sepolia.service -n 100
journalctl -u cloudflared-megaeth-testnet.service -n 100
# The existing rebates tunnel is the plain cloudflared.service unit:
journalctl -u cloudflared.service -n 100
```

## Single-chain restart (without affecting the other or rebate-indexer)

```bash
cd /srv/ophis/infra/optimism
docker compose -f docker-compose.testnet.yml --env-file /srv/ophis/infra/optimism/.env restart
# Or, to fully recreate:
docker compose -f docker-compose.testnet.yml --env-file /srv/ophis/infra/optimism/.env down
docker compose -f docker-compose.testnet.yml --env-file /srv/ophis/infra/optimism/.env up -d
```

The compose project name is scoped by directory; restarting `optimism` doesn't touch `megaeth` containers.

## Adding a third chain (template)

When Spec 2/3 promote to mainnet (or a new chain), the same pattern repeats:

1. Create `infra/<chain>/docker-compose.<env>.yml` using a port range that doesn't collide. Reserved so far: `8080` (rebates), `8100/8101` (optimism), `8082/8083` (megaeth). For Spec 2/3 mainnet: pick `8110/8111` (optimism-mainnet) + `8084/8085` (megaeth-mainnet) or similar.
2. `rsync` to `/srv/ophis/infra/<chain>/`
3. `docker compose build`, then `up -d` with `--env-file /srv/ophis/infra/<chain>/.env`
4. `cloudflared tunnel create ophis-<chain>` from the VM, write `/etc/cloudflared/<chain>.yml`
5. Add a CNAME `<chain>.ophis.fi → <UUID>.cfargotunnel.com` proxied via the CF API. **Use single-level hostnames** — Cloudflare Universal SSL doesn't cover multi-level subdomains (`api.<chain>.ophis.fi` would need paid Advanced Certificate Manager). The 2026-05-12 Spec 1 work hit this and renamed.
6. Write `/etc/systemd/system/cloudflared-<chain>.service`, `systemctl enable --now`.

## Where the secrets live

- **Driver-submitter EOA private key:** `/srv/ophis/.env.shared` on the VM (mode 600), key `DRIVER_SUBMITTER_PRIVATE_KEY`. Sourced from macOS Keychain entry `greg-driver-submitter` at deploy time. Same key is referenced by both chain stacks.
- **Per-chain Postgres credentials and RPC URLs:** `/srv/ophis/infra/<chain>/.env`. These are operator-managed, gitignored.
- **Cloudflare API token:** macOS Keychain entry `cloudflare-api-token` (also a repo-level GitHub secret `CLOUDFLARE_API_TOKEN` for CI). Has DNS:Edit on `ophis.fi` zone. Used for CNAME creation; **not** for tunnel-creation.
- **Cloudflare tunnel cert.pem:** `/root/.cloudflared/cert.pem` on the VM. Created once during the rebate-indexer revival 2026-05-11; reused by all subsequent `cloudflared tunnel create` invocations on the same VM. Lacks DNS:Edit permission, which is why CNAMEs are created via the API token instead.

## Smoke tests

```bash
# Optimism Sepolia E2E
cd /Users/scep/greg/infra/optimism/scripts
export OPTIMISM_SEPOLIA_GTUSD=0xf9cc3c9982d8ad424fa8071f09f3fa3072bc03a1
export OPTIMISM_SEPOLIA_TEST_WALLET_PK=$(security find-generic-password -l greg-chiado-test -w)
pnpm smoke

# MegaETH testnet partial (should print "✓ simulated, sequencer-bug stop expected")
cd /Users/scep/greg/infra/megaeth/scripts
export MEGAETH_TESTNET_GTUSD=<from infra/megaeth/.env on the VM>
export MEGAETH_TESTNET_TEST_WALLET_PK=$(security find-generic-password -l greg-megaeth-deployer -w)
pnpm smoke
```

The Optimism Sepolia smoke test passes when the orderbook reports our order in a winning solver-competition (`/api/v1/solver_competition/latest` with `solutions[*].isWinner=true`). This proves the full pipeline: order acceptance → autopilot → native-price → baseline solver → settlement encoding → simulation → score → winner selection.

**Pre-conditions:**

1. `greg-chiado-test` wallet (`0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB`) must have ≥ 0.001 ETH (gas) AND ≥ 0.001 WETH on Optimism Sepolia. Fund via [Optimism Sepolia faucet](https://docs.optimism.io/builders/tools/build/faucets); wrap to WETH at the predeploy `0x4200000000000000000000000000000000000006`.
2. The chain stack RPC (`/srv/ophis/infra/optimism/.env` → `OP_SEPOLIA_RPC`) must have headroom for the CoW driver's continuous loops. Empirically the driver idles at ~5-10 RPS just on block-stream/token-fetcher. **Free tiers don't cut it.** Verified working: Alchemy Growth ($49/mo, 660 CUPS) or self-hosted op-node. The on-chain settlement broadcast specifically needs RPC headroom because the driver re-simulates immediately before `eth_sendRawTransaction`; a single 429 in that window causes the driver to abandon the auction.

### Why the smoke test doesn't assert on the settlement tx

On a saturated RPC the driver can win auctions but fail to broadcast (logged as `failed to settle err=SubmissionError`, root cause `429`). That's a backend-environment problem, not a backend-correctness problem — every contract, signature, and encoding step succeeds. So the smoke test exits 0 on `isWinner=true` and explicitly notes that broadcast depends on RPC headroom. The mainnet smoke tests (Spec 2/3) will assert on the tx hash because mainnet operations always run on paid RPC.

### Verified pass 2026-05-12 (Spec 1 close)

Order uid `0xe1f34360ad9eeec2febb38df225ad39392f1284e61fc60023262506089df7205412cbcce46fcba707a3190eced8113bbc2c294ab6a02fa77` placed by the smoke test. Reached auction `7822` at block `43388684`. Baseline solver returned `isWinner=true` with `score=425894934335156` and computed `executedBuy=3798637742005625271` (≈3.8 GTUSD per 0.001 WETH; matches pool reserves at the time). Submission failed-to-settle on the running Alchemy free-tier app due to the 330 CUPS cap.

## Useful constants

| Thing | Optimism Sepolia | MegaETH testnet |
|---|---|---|
| Chain ID | 11155420 | 6343 |
| RPC | https://sepolia.optimism.io | https://carrot.megaeth.com/rpc |
| Explorer | https://sepolia-optimism.etherscan.io | https://megaexplorer.xyz |
| WETH predeploy | `0x4200000000000000000000000000000000000006` | (chain-specific) |
| Greg Settlement | `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` | `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` |
| Greg VaultRelayer | `0x842F655C9310C32e5932A0eBFa80c4Cd358c0205` | `0x842F655C9310C32e5932A0eBFa80c4Cd358c0205` |
| Greg V2 factory | `0x29fcdbbdffd12fa7724b863991355b82ba8380e2` | (see VM `.env`) |
| GTUSD test token | `0xf9cc3c9982d8ad424fa8071f09f3fa3072bc03a1` | (see VM `.env`) |
| Driver-submitter EOA | `0x00f98b5776eb0f6a8c0c925ddF51f9Ade8a1502F` | same |
| Test wallet (greg-chiado-test) | `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` | n/a |
