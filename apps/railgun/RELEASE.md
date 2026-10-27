# Private wallet release

The Ethereum private WETH→USDC route has completed a funded transaction through a real broadcaster, including the Uniswap trade, Ophis fee and USDC reshield. The private output was independently observed in the wallet, progressed to Spendable after validation, and the pending journal cleared. Native ETH deposits and a broadcaster withdrawal were also confirmed. Transaction identifiers and private wallet details are retained outside the repository.

Public deployment and the Ophis entry link are opt-in. The user has authorized merge and deployment once the applicable checks pass. Final-head hosted checks and production deployment verification remain gates; see [SECURITY_REVIEW.md](./SECURITY_REVIEW.md). f(x) remains paused. No new Ethereum contract or Ophis SDK release is required.

## Release order

1. Complete the current-source security review, standalone frozen install, tests, typechecks, build and required hosted checks. Assess the actual browser dependency graph using [DEPENDENCIES.md](./DEPENDENCIES.md); the version audit has outstanding advisories.
2. Confirm the live reshielded output becomes Spendable after Railgun validation. Do not infer this from an outer successful receipt or ShieldPending alone. No additional deposit or trade is needed for this check.
3. Merge the reviewed PR. Run **Deploy Railgun private wallet** on `main` using the protected Production environment.
4. Verify `https://private.ophis.fi`, its security headers, Ethereum chain ID and denial of administrative RPC methods. Check delegated calls and tracing through that deployed gateway.
5. Only after those checks, set the repository variable `REACT_APP_PRIVATE_WALLET_URL=https://private.ophis.fi` and rebuild/deploy the Ophis frontend. Its existing **Private wallet** link then opens the separate wallet origin.

WalletConnect uses the public repository variable `REACT_APP_WC_PROJECT_ID`; the wallet build fails if it is missing. Public project IDs are not signing credentials. Review the project's allowed origins for the production domain.

Wallet storage belongs to its browser origin. A wallet created on localhost will not appear automatically on the production domain. Its owner must restore it locally using their own recovery phrase; never send that phrase to an operator or support channel.

## Runtime boundaries

The separate origin isolates encrypted Railgun keys and journals from Ophis frontend analytics. Keep Cloudflare observability, third-party script injection, request-body logging, workers.dev and preview URLs disabled. Static assets and RPC responses use no-store headers; framing is disabled.

`wrangler.jsonc` defaults RPC forwarding off. The deployment explicitly builds `VITE_RAILGUN_ENVIRONMENT=ethereum`, sets `RAILGUN_RPC_ENABLED=true` and selects the trusted HTTPS origin `https://railgun-rpc.ophis.fi/rpc`. The server-only `RAILGUN_RPC_TOKEN` is required for nonlocal forwarding. Client Authorization is never forwarded. A missing secret fails closed; install it before the public link is enabled.

The restricted gateway permits wallet RPC methods, 20-call batches and 256 KiB bodies. Each batched call consumes a rate-limit token. Limits per IP and Cloudflare location are 600 calls/minute and 10 traces/minute; shared exits can encounter limits. Calls and estimates are capped at 30 million gas. Tracing requires `callTracer`, a five-second timeout and no custom tracer. Log queries require the pinned Ethereum proxy and at most 500 explicit blocks; fee history is limited to 64 blocks. Administrative methods and upstream redirects are rejected. Raw transaction submission supports user-signed recovery; the server holds no signing key.

Baal's synced Ethereum node supports the delegated reads and HTTP tracing used by this wallet. Its authenticated Cloudflare Tunnel/Caddy transport publishes no host ports and has independent method, path, authentication and body-limit checks. See [deploy/README.md](./deploy/README.md).

## Read-only readiness check

With authorized access to the trusted node or protected origin:

```sh
RAILGUN_READINESS_RPC_URL=http://100.69.134.7:8547 node tests/live-services.mjs
```

For the HTTPS origin, use `RAILGUN_READINESS_RPC_URL=https://railgun-rpc.ophis.fi/rpc` and supply `RAILGUN_READINESS_RPC_TOKEN` securely. Never put its value in shell history or logs. The check reads node status, canonical delegation, tracing, PPOI availability and fresh signed broadcaster advertisements. It does not submit a transaction or establish an individual wallet's spendability.

## Supported behavior and limits

The initial route supports Ethereum USDC↔WETH through Uniswap v3. Native ETH shielding wraps and shields atomically through the existing Relay Adapt contract. Private balances hold WETH. Public approval/deposit transactions require the user's wallet confirmation; private proving and submission remain separate review actions.

The swap quote preserves the requested fixed amount. If needed, it caps price per gas to the private fee budget without lowering the full SDK estimate, the 3m gas floor or the SDK's 20% gas-limit margin. A fresh network-price check can reject an obsolete cap. Capped estimates round upward to 10,000 gas units. No gas-price cap guarantees future inclusion or broadcaster acceptance.

**Max swap after fee** rebuilds at most four times and reserves 25% headroom above the last insufficient fee. It never increases the original balance/budget cap. The extra headroom can become part of the committed private broadcaster fee; it is not a refund promise. A full-balance manual quote shows the adjusted trade for review. Partial fixed amounts are not silently reduced.

Only Spendable private funds pay a trade and its broadcaster fee. ShieldPending, public funds and pending deposits do not count. New shields normally have a standby period before PPOI eligibility. The SDK may retain cached POI statuses after a network failure, so completing a refresh does not certify remote freshness.

The DEX trade and its amounts are public; this does not make CoW orderbook orders private or prevent sandwiches within the slippage limit. The trusted simulation RPC sees the signed executable batch and can submit it. A successful outer receipt alone is insufficient: execution checks the committed private output. Preserve encrypted recovery journals until reconciliation completes.
