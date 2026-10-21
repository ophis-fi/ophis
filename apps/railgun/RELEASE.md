# Release preparation

The wallet application remains unmerged and undeployed. Its production custom domain is configured, but its RPC defaults off. The authenticated RPC transport has now been deployed separately on Baal and verified; see [deploy/README.md](./deploy/README.md). No new Ethereum contract is required. f(x) is outside this release.

The user subsequently authorized merging and deploying **if all applicable checks are green**. That authorization persists, but the condition is not met; see [SECURITY_REVIEW.md](./SECURITY_REVIEW.md). No further generic merge/deploy approval is needed once the actual release gates are closed.

## Infrastructure verified

Baal's missing HTTP trace namespace was fixed on 2026-10-21. The exact setting `EL_EXTRAS=--http.api eth,net,web3,debug --rpc.max-tracing-requests 1` is applied. Only the execution container was recreated, preserving its image, volumes and Tailscale-only port bindings. The original `.env` was backed up on Baal. The node returned to synced status, actual EIP-7702 calls and `callTracer` passed, and consensus/validator start times and restart counts remained unchanged.

The gateway can now reach Baal through `https://railgun-rpc.ophis.fi/rpc`, a dedicated authenticated Cloudflare Tunnel/Caddy origin. Neither transport container publishes host ports. Missing/wrong credentials, method/path restrictions and oversized valid JSON rejection passed independently of the edge policy. The actual Workerd gateway passed delegated reads and tracing through this HTTPS origin; its client header was replaced with the server credential, and administrative methods were rejected.

Run the reproducible **read-only** check while the local development server is available:

```sh
RAILGUN_READINESS_RPC_URL=http://100.69.134.7:8547 node tests/live-services.mjs
```

This checks the node, canonical delegation, tracing, live PPOI status and fresh signed Waku advertisements. A trace failure makes the command exit unsuccessfully even when the other checks pass. The test creates an empty ephemeral account solely for delegated read simulation; it never signs a swap batch, submits a PPOI proof, or broadcasts a transaction. Service health and advertisements alone do not establish live spendability or transaction acceptance. For the protected HTTPS origin, set `RAILGUN_READINESS_RPC_URL=https://railgun-rpc.ophis.fi/rpc` and supply `RAILGUN_READINESS_RPC_TOKEN` securely from the generated secret; do not put its value in shell history or logs.

## Hosting configuration

`wrangler.jsonc` and `server/index.ts` prepare a dedicated wallet origin with static assets and a same-origin JSON-RPC gateway. The application retains its own IndexedDB and has no Ophis analytics integration. Asset headers disable framing, dynamic script evaluation and caching. RPC responses also disable caching and strip upstream cookies and headers. Cloudflare observability, workers.dev and preview URLs default off; do not enable analytics, request-body logging or third-party script injection on this origin.

The gateway permits only the methods used by the wallet. Both browser and SDK providers share its 20-call batch limit. The request body is limited to 256 KiB; each call consumes a general limit token, including batched calls. Per Cloudflare location, an IP is limited to 600 RPC calls/minute and 10 traces/minute. These are abuse limits rather than identity or privacy guarantees; shared exits can encounter limits.

Calls and gas estimates are capped at 30 million gas; supplied calldata and authorization lists remain intact. Traces require `callTracer`, use a five-second timeout and reject custom tracers. Log queries require the pinned Ethereum V2 proxy and either a block hash or an explicit range of at most 500 blocks, matching SDK scanning. Fee history is limited to 64 blocks. Admin RPC methods are rejected. Raw signed transactions are supported for self-sponsored recovery/cancellation, with no server-held signing key. Upstream redirects are rejected.

For a local production-runtime smoke check, use the **fork build**, prepare the marker, then:

```sh
pnpm build
cp .dev.vars.example .dev.vars
WRANGLER_SEND_METRICS=false pnpm --ignore-workspace dlx wrangler@4.151.3 dev --ip 127.0.0.1 --port 4321
```

Open http://127.0.0.1:4321 with a disposable test wallet. HTTP upstreams are accepted only for a loopback request forwarding to a loopback node. A public request requires a trusted HTTPS upstream. `.dev.vars` is ignored by Git; never upload it or use its Anvil URL for production.

After infrastructure and release review, the mainnet build must explicitly use `VITE_RAILGUN_ENVIRONMENT=ethereum`. Set `RAILGUN_RPC_URL` on the server to the trusted HTTPS endpoint, review its availability and logging, then deliberately enable `RAILGUN_RPC_ENABLED=true`. Set the server-only `RAILGUN_RPC_TOKEN` secret. Nonlocal forwarding fails closed without it; incoming client Authorization never reaches the node. Keep upstream credentials server-side. The separate domain `private.ophis.fi` is configured. Verify its deployment before enabling the Ophis footer's `REACT_APP_PRIVATE_WALLET_URL`; leave that variable unset while release gates remain open. Clean the frontend build output before release so earlier opt-in bundles are not retained.

## Remaining release gates

1. Infrastructure readiness is complete, including authenticated HTTPS and actual Workerd tracing; retain these checks during deployment.
2. Review the dependency backports and remaining advisories in [DEPENDENCIES.md](./DEPENDENCIES.md). The Waku wallet peer-range exception has local envelope/crypto and live discovery coverage, but still needs live transaction acceptance.
3. Complete approval and shielding with an actual injected browser wallet on the marked fork. MetaMask connection, rejection and network switching passed, but its insufficient-funds confirmation disagreed with the funded fork RPC. The successful full roundtrip uses an Anvil wallet shim.
4. For a specifically authorized test wallet and budget, shield a small amount, wait for actual PPOI eligibility, submit through a real broadcaster, and verify the committed private output, withdrawal and recovery. The fork fixture cannot establish these live results.
5. Review the final local change and required GitHub checks before using the conditional merge/deploy authorization. A funded mainnet trial still requires a dedicated test wallet, signing method and explicit spending cap; none was provided or used.
