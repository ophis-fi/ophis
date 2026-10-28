# Private swap release

This release integrates the reviewed runtime inside `swap.ophis.fi`, using the existing Ophis swap page and supplied incognito icon. It does not restore `private.ophis.fi`. The private fee is 10 bp (0.1%) of final swap output; the public SDK remains at 1 bp. No new contract deployment, SDK release or f(x) work is included.

## Release order

1. Pass the applicable source reviews, unit/security regressions, TypeScript checks, production builds and hosted checks. Assess outstanding dependency advisories using [DEPENDENCIES.md](./DEPENDENCIES.md) and [MULTICHAIN-REVIEW.md](./MULTICHAIN-REVIEW.md).
2. Build the runtime with `VITE_RAILGUN_ENVIRONMENT=mainnet`, `VITE_RAILGUN_ASSET_BASE=/private/` and the existing public WalletConnect project ID. Build the frontend with the private feature flag and run `node scripts/stage-private-swap.mjs`. Check the staged production bundle, not an earlier preview.
3. Merge the reviewed changes on Ophis's actual default branch, `main`. Keep `REACT_APP_PRIVATE_SWAP_ENABLED` unset until the gateway passes its deployment checks.
4. Set the protected Production environment's server-only `RAILGUN_ZAN_API_KEY` from the existing Ophis account, preserving `RAILGUN_RPC_TOKEN`. Run **Deploy private swap RPC** on `main`. It checks all upstreams before deploying `ophis-private-rpc` on `swap.ophis.fi/rpc*`, installs secrets while forwarding is disabled, then enables forwarding and checks all four deployed networks.
5. After gateway postflight succeeds, set repository variable `REACT_APP_PRIVATE_SWAP_ENABLED=true` and run **Deploy to Cloudflare Pages** on `main`. Verify both public and private swap pages, the supplied icon, mobile layout, CSP, iframe and WASM assets. Verify unsupported chains and administrative RPC methods fail closed. Never use a user's wallet or broadcast a funded transaction for deployment verification.

WalletConnect uses the existing public `REACT_APP_WC_PROJECT_ID`, with `swap.ophis.fi` allowed by Reown. Wallet storage belongs to the browser origin: a localhost wallet does not automatically appear on the production domain. Its owner restores it locally using their own recovery phrase. Never send that phrase to an operator or support channel.

## Runtime and provider boundaries

Public-to-private navigation loads a fresh document. Private entry skips GA4, Sentry and service-worker registration; wallet databases, journals and proof artifacts are preserved during existing public storage migrations. Private responses prohibit remote scripts, disable framing by other origins, set no-store and no-referrer headers, and separate public openers with COOP. The iframe has a separate module bundle but shares Ophis's first-party origin and storage trust. It is not isolation from a compromised same-origin application.

Ethereum uses Baal's synced node through the existing authenticated `https://railgun-rpc.ophis.fi/rpc` transport. Arbitrum, Polygon and BNB Chain use the existing Ophis ZAN account. Its API key remains in Worker secrets, and only fixed ZAN host/chain paths qualify for API-key authentication. Explicit upstream overrides still require a bearer token. No new account, subscription or public fallback is configured. Remaining account credits were not established; monitor shared quota operationally.

The restricted gateway permits wallet RPC methods, 20-call batches and 256 KiB bodies. Limits per IP and Cloudflare location are 600 calls/minute and 10 traces/minute. Calls and estimates are capped at 30 million gas. Tracing requires `callTracer`, a five-second timeout and no custom tracer. Log queries require the selected network's pinned Railgun proxy and at most 500 explicit blocks. Administrative methods and redirects are rejected. Raw transaction submission supports user-signed recovery; the server has no signing key. Observability, workers.dev and preview URLs remain disabled.

## Validation and operational limits

Four isolated local forks passed native deposit, real proof generation, private swap, confirmed private output, journal cleanup and exact 0.1% recipient payment. Delegated calls and traces passed through the selected gateway on all four chains. Existing Ethereum live execution was previously user-confirmed; this release's added-chain proof tests use a guarded fork POI adapter and local sponsor. Live added-chain PPOI delivery and broadcaster acceptance remain external checks, not claims established by fork tests.

Only Spendable notes pay swaps and broadcaster fees. Public and ShieldPending funds do not count. Mainnet deposits require a fresh compatible broadcaster offer, and swap preparation also checks the receive asset. Polygon native USDC had no compatible offer during final discovery; its deposit and receive paths block safely until availability changes.

The DEX trade and its amounts are public and can be sandwiched within the slippage limit. The trusted simulation RPC sees the signed executable batch and may submit it. A successful outer receipt alone is insufficient: execution checks committed private output and retains recovery journals until reconciliation. Dependency version scanning still reports advisories; reviewed browser reachability and backports are documented, not a zero-finding certification.
