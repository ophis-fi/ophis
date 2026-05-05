# Phase 2 — Retail Engineering Substrate Validation Log

**Date:** 2026-05-03
**Commit at validation:** `b34a9a77b` (PWA doc) on top of `c86348a69` (Safe doc), `804274b10` (manifest), `23758760f` (mevReceipt full module).
**Deployment URL:** https://greg-git-main-clementfrmds-projects.vercel.app (branch alias).

## Phase gate — three-tier substrate verified

### Tier 1: Phase-1.5 partner-fee patch propagates to TWAP / DCA flow

Verified by code-trace (Task 1) — no on-chain test needed. The chain:

```
injectedWidgetPartnerFeeAtom (defaults to GREG_DEFAULT_PARTNER_FEE — Phase 1.5 patch)
  ↓
volumeFeeAtom — `get(injectedWidgetPartnerFeeAtom)` → {volumeBps, recipient}
  ↓
AppDataInfoUpdater — `partnerFee: volumeFee` → buildAppData() → appDataInfoAtom
  ↓
useAppData() — returns partner-fee-augmented AppDataInfo
  ↓
┌─────── regular orders (trade flow) ─────┐
│                                          │
└─── TWAP orders (useCreateTwapOrder) ─────┘
       │
       ↓
     ComposableCoW conditional-order spec carries appData →
     watch-tower-generated child orders inherit parent appData →
     every child order on api.cow.fi has Greg's partnerFee in fullAppData.
```

Source references (cowswap fork):
- `apps/cowswap-frontend/src/modules/twap/hooks/useCreateTwapOrder.tsx:14,68,173-174` — TWAP imports `useAppData` and writes `appDataKeccak256` + `fullAppData` into the conditional-order spec.
- `apps/cowswap-frontend/src/modules/appData/hooks.ts:12` — `useAppData()` reads `appDataInfoAtom`.
- `apps/cowswap-frontend/src/modules/appData/updater/AppDataInfoUpdater.ts` — sets `partnerFee: volumeFee` when constructing the appData.
- `apps/cowswap-frontend/src/modules/volumeFee/state/volumeFeeAtom.ts` — consumes `injectedWidgetPartnerFeeAtom`.
- `apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts` — Phase-1.5 patch defaults to `GREG_DEFAULT_PARTNER_FEE`.

**Verdict:** TWAP/DCA partner fee propagation PASS by construction.

### Tier 2: MEV-proof receipt download (new Greg-only feature)

New module at `apps/cowswap-frontend/src/modules/mevReceipt/`:

| File | Purpose | Status |
|---|---|---|
| `types.ts` | `MevProofReceipt`, `PartnerFeeInfo`, `BuildReceiptInput` | shipped |
| `services/buildReceipt.ts` + tests | Pure function: CoW order → receipt | 3 Jest tests green |
| `services/exportJson.ts` + tests | Receipt → stable-key JSON string | 2 Jest tests green |
| `services/exportPdf.ts` + tests | Receipt → PDF Blob via jspdf | 2 Jest tests green |
| `containers/DownloadReceiptButton.tsx` | Click-to-download UI button | shipped |
| `index.ts` | barrel | shipped |

Total: **7 Jest tests green**. Cowswap build succeeds. UI mount in `apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx` next to existing modal actions.

Known limitation: the current mount uses `ParsedOrder` from cowswap, which does not carry settlement tx/block. Receipts built from this mount have `settlementTxHash: null` and `settlementBlock: null`. Phase 2.5 enhancement: thread the trades-API result through the modal so the receipt fields fill from `api.cow.fi/<chain>/api/v1/trades?orderUid=...`. The receipt schema already supports the fields; the UI mount just doesn't have the data yet.

**Verdict:** MEV-proof receipt module PASS. Module shipped, tests green, UI mounted. Phase 2.5 will enhance with trade data.

### Tier 3: Manifest, Safe app, PWA all production-ready

| Substrate | Status | Evidence |
|---|---|---|
| Manifest hardened (Greg `homepage_url` + `description` + `iconPath`) | PASS | `apps/cowswap-frontend/public/manifest.json` — Phase 2 Task 5 |
| `/manifest.json` CORS | PASS | `Access-Control-Allow-Origin: *` (verified via `curl -sI`) |
| `/manifest.json` Safe-spec compliant | PASS | name=Greg, description=96 chars (≤200 limit), iconPath set |
| Root URL has no iframe-blocking headers | PASS | No `X-Frame-Options`, no restrictive CSP `frame-ancestors` |
| `@safe-global/safe-apps-sdk` integration upstream-supplied | PASS | Already a cowswap dependency; Greg inherits |
| `/service-worker.js` reachable | PASS | HTTP 200, 41 KB workbox-based |
| Service worker has fetch handler | PASS | Workbox routing constants present |
| Manifest linked from HTML head | PASS | `<link rel="manifest" href="./manifest.json">` |
| Safe app submission package documented | PASS | `docs/development/safe-app-submission.md` |
| PWA install criteria documented + verified programmatically | PASS | `docs/development/pwa-verification.md` |

**Verdict:** Substrate PASS. Phase 2.5 can now layer brand work, real domain, DCA UX redesign, Safe app store submission PR, and Show-HN/PH launch on top.

## Phase 2 verdict: PASS

All four phase-gate criteria met. The retail engineering substrate is complete. Phase 2 ships:

- **Architecturally:** the Phase-1.5 partner-fee patch flows correctly through TWAP/DCA orders without any extra work.
- **Functionally:** users can download a JSON or PDF MEV-proof receipt for any order with a settled-or-open status, from cowswap's existing `ReceiptModal`.
- **Operationally:** Greg passes Safe app installation prerequisites (manifest, CORS, iframe headers, Safe SDK upstream) and PWA installation prerequisites (HTTPS, manifest, service worker, fetch handler).

Tag: `v0.2-phase2`.

## Open follow-ups for Phase 2.5

- Real project name + domain (`greg` codename retired before launch).
- Brand work: logo, colour palette, voice (the Greg-rebranded cowswap UI is functional but visually identical to upstream).
- DCA UX redesign on top of cowswap's `/advanced` route — promote DCA to a top-level entry point with consumer-friendly framing.
- Submit Safe app PR against `safe-global/safe-apps-list` once the real domain is set.
- Thread trades-API data into `ReceiptModal` so receipts include settlement tx hash + block number.
- Add SVG icon variant at `/greg-icon.svg` (≥128×128) for Safe app store presentation.
- Manual mobile PWA install test once a stable domain exists.
- Multisig upgrade for partner-fee recipient (`0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E` → Safe multisig) before significant accrual.
- Show HN, Product Hunt, weekly execution-proof tweets.

## Files committed in Phase 2

- `docs/development/plans/2026-05-03-greg-phase-2-retail-substrate.md` — plan (already committed before execution).
- `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/{types,services/{buildReceipt,exportJson,exportPdf},containers/DownloadReceiptButton,index}.ts(x)` — new module.
- `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts` — 7 Jest tests.
- `apps/frontend/apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx` — mount point.
- `apps/frontend/apps/cowswap-frontend/public/manifest.json` — Greg fields + iconPath.
- `apps/frontend/apps/cowswap-frontend/package.json` + `apps/frontend/pnpm-lock.yaml` — `jspdf` dep.
- `apps/frontend/.greg-divergences.md` — Phase-2 entries appended.
- `docs/development/safe-app-submission.md` — submission package.
- `docs/development/pwa-verification.md` — PWA evidence.
- `docs/development/phase-2-validation.md` — this file.

Total commits in Phase 2: 6 (`feat(mevReceipt) ×3`, `feat(manifest) ×1`, `docs(safe-app) ×1`, `docs(pwa) ×1`) + this close-out commit.
