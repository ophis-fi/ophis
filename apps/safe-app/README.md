# @ophis/safe-app

An Ophis Swap **Safe{Wallet} App**: lets a Safe (DAO treasury) swap via Ophis (CoW Protocol) so each order carries the Ophis partner fee (to the Ophis Safe) plus an integrator **referral code** that earns the 8-12% rev-share. A plain Vite + React SPA loaded in an iframe by app.safe.global. No backend, no new contracts, no custody.

## How it works (presign flow)
A Safe is a smart-contract wallet, so CoW uses the **presign** path, not an EIP-1271 off-chain signature (the fork forces this in `apps/frontend/libs/wallet/.../updater.ts`):
1. Quote against the **Ophis** orderbook host (`getOphisOrderbookUrl`; OP -> optimism-mainnet.ophis.fi, never api.cow.fi).
2. Build deterministic **appData** with `partnerFee` + `ophisReferrer.code` (`lib/appData.ts`).
3. POST the order (`signingScheme: PRESIGN`, `signature = Safe address`) -> `orderUid` (PRESIGNATURE_PENDING).
4. Register the Safe in the rebate indexer (`GET /tier/<safe>`, `lib/tracking.ts`). **Without this the rebate is never credited** even though the code is in appData, because the indexer's fetcher is owner-scoped (CoW `/trades?owner=` cannot be globally enumerated).
5. Propose `GPv2Settlement.setPreSignature(orderUid, true)` to the Safe queue (`to` = `getOphisSettlementAddress`; OP non-canonical `0x310784c7...`). Owners co-sign + execute; then the solver settles.

## Run
```
pnpm --filter @ophis/safe-app dev      # then add it as a custom app in app.safe.global pointing at the dev URL
pnpm --filter @ophis/safe-app build
```
Add `apps/safe-app` to `pnpm-workspace.yaml` if `apps/*` is not already globbed.

## Deploy
Host at **safe.ophis.fi** (Cloudflare Pages, like swap.ophis.fi). Confirm `https://safe.ophis.fi/manifest.json` returns `Access-Control-Allow-Origin: *` (Safe fetches it cross-origin to register the app). Then submit to the Safe Apps registry (`safe-global/safe-apps-list` PR) and/or share the custom-app URL.

## Before production (TODOs)
- [x] Real brand claw at `public/ophis-icon.svg` (square viewBox).
- [x] `@ophis/sdk` exports are surfaced from the package root and resolve — `typecheck` + `build` of this app run as a BLOCKING CI job (`.github/workflows/ci.yml`, `safe-app`); the cow-sdk v5 `OrderBookApi` signatures compile against the resolved version.
- [x] Native-ETH / zero / malformed sell+buy tokens are REJECTED up front with a clear error (`lib/tokens.ts`, enforced in `quote.ts` and re-asserted before the approval in `submit.ts`). FULL native-ETH *support* still needs the eth-flow path (separate contract + value tx) and stays out of scope for this ERC-20-only app.
- [ ] Pin `@cowprotocol/cow-sdk` + React to exact versions the fork resolves (the app compiles against cow-sdk v5; pin to lock it).
- [ ] Confirm `VITE_OPHIS_REBATE_API` and that the indexer allows cross-origin `GET /tier/<safe>` from safe.ophis.fi (or move that call server-side).
- [ ] Stable-pair detection for the 1bp tier (`ophisVolumeBpsForPair`); a real token picker; balance + decimals handling.
- [ ] Multi-owner UX: `sdk.txs.send` only queues; make the latency until threshold owners execute explicit.
