# @ophis/safe-app

An Ophis Swap **Safe{Wallet} App**: lets a Safe (DAO treasury) swap via Ophis (CoW Protocol) so each order carries the Ophis partner fee (to the Ophis Safe) plus an integrator **referral code** that earns the 8-12% rev-share. A plain Vite + React SPA loaded in an iframe by app.safe.global. No backend, no new contracts, no custody.

## How it works (presign flow)
A Safe is a smart-contract wallet, so CoW uses the **presign** path, not an EIP-1271 off-chain signature (the fork forces this in `apps/frontend/libs/wallet/.../updater.ts`):
1. Quote against the **Ophis** orderbook host (`getOphisOrderbookUrl`; OP -> optimism-mainnet.ophis.fi, never api.cow.fi).
2. Build deterministic **appData** with `partnerFee` + `ophisReferrer.code` (`lib/appData.ts`).
3. POST the order (`signingScheme: PRESIGN`, `signature = Safe address`) -> `orderUid` (PRESIGNATURE_PENDING).
4. Register the Safe in the rebate indexer (`GET /tier/<safe>`, `lib/tracking.ts`). **Without this the rebate is never credited** even though the code is in appData, because the indexer's fetcher is owner-scoped (CoW `/trades?owner=` cannot be globally enumerated).
5. Propose `GPv2Settlement.setPreSignature(orderUid, true)` to the Safe queue (`to` = `getOphisSettlementAddress`; OP non-canonical `0x310784c7...`). Owners co-sign + execute; then the solver settles.

### Native ETH (wrap-in-batch, not eth-flow)
Selling native ETH prepends `WETH.deposit{value}` to the approve + presign batch, in the SAME Safe execution (`lib/weth.ts`, `lib/submit.ts`): the Safe wraps its own ETH to WETH and the order sells WETH, so the order **owner stays the Safe** and the rebate attributes exactly as for any ERC-20 swap. CoW eth-flow is deliberately NOT used — its order owner is the eth-flow *contract*, which the owner-scoped indexer never fetches, so the Ophis fee would still be taken but the trader's rebate silently lost. WETH addresses come from cow-sdk's `WRAPPED_NATIVE_CURRENCIES`.

## Run
```
pnpm --filter @ophis/safe-app dev      # then add it as a custom app in app.safe.global pointing at the dev URL
pnpm --filter @ophis/safe-app build
```
Add `apps/safe-app` to `pnpm-workspace.yaml` if `apps/*` is not already globbed.

## Deploy
Ships to **safe.ophis.fi** via Cloudflare Pages on push to `main` (`.github/workflows/safe-app-deploy.yml`, project `ophis-safe-app`). `public/_headers` serves `Access-Control-Allow-Origin: *` site-wide so Safe can fetch `/manifest.json` AND the icon cross-origin.

ONE-TIME operator setup (the deploy step fails until done):
1. `pnpm dlx wrangler pages project create ophis-safe-app --production-branch main` (or CF dashboard -> Pages -> Direct Upload).
2. Bind the `safe.ophis.fi` custom domain to the `ophis-safe-app` project in the CF dashboard — ophis.fi DNS is on Cloudflare, so the proxied CNAME is auto-created (no manual DNS record).

Post-deploy: `curl -sI https://safe.ophis.fi/manifest.json | grep -i access-control-allow-origin` (expect `*`), then submit to the Safe Apps registry (`safe-global/safe-apps-list` PR) and/or share the custom-app URL.

## Before production (TODOs)
- [x] Real brand claw at `public/ophis-icon.svg` (square viewBox).
- [x] `@ophis/sdk` exports are surfaced from the package root and resolve — `typecheck` + `build` of this app run as a BLOCKING CI job (`.github/workflows/ci.yml`, `safe-app`); the cow-sdk v5 `OrderBookApi` signatures compile against the resolved version.
- [x] Native-ETH SELLS supported via wrap-in-batch (`lib/weth.ts` + `submit.ts`) — keeps the rebate (owner = Safe). Zero / malformed tokens, and native ETH as the BUY token, are still rejected up front (`lib/tokens.ts`). Receiving native ETH (buy side) means buying WETH then unwrapping separately — not yet a one-click flow.
- [x] Deploy wired: `safe-app-deploy.yml` -> safe.ophis.fi (Cloudflare Pages). Needs the one-time operator setup in **Deploy** above.
- [ ] Pin `@cowprotocol/cow-sdk` + React to exact versions the fork resolves (the app compiles against cow-sdk v5; pin to lock it).
- [ ] Confirm `VITE_OPHIS_REBATE_API` and that the indexer allows cross-origin `GET /tier/<safe>` from safe.ophis.fi (or move that call server-side).
- [ ] Stable-pair detection for the 1bp tier (`ophisVolumeBpsForPair`); a real token picker; balance + decimals handling.
- [ ] Multi-owner UX: `sdk.txs.send` only queues; make the latency until threshold owners execute explicit.
