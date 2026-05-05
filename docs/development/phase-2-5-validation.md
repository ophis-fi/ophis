# Phase 2.5 — Public Launch Validation Log

**Date:** 2026-05-03
**Tag:** `v0.2.5-phase2-5`
**Production URL:** https://greg-clementfrmds-projects.vercel.app (canonical) + https://greg-git-main-clementfrmds-projects.vercel.app (branch alias)
**Repo HEAD at validation:** see `git rev-parse HEAD` at tag time.

## Operator decisions captured

| Decision | Choice | Note |
|---|---|---|
| **D1 — Brand / project name** | **Keep `greg`** | Codename retained for launch. Real brand work deferred to a Phase 2.6 mini-plan when a name surfaces. |
| **D2 — Production domain** | **Vercel default alias** | `greg-clementfrmds-projects.vercel.app`. Real domain swap deferred to Phase 2.6 alongside brand. |
| **D3 — Multisig partner-fee recipient** | **Gnosis Safe v1.4.1, threshold 1-of-1, owner `0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`** | Safe address `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`. CREATE2-deterministic across all 10 CoW chains. **Pre-revenue task: upgrade to ≥ 2-of-N before significant accrual** — 1-of-1 has the same operational security as a single-key EOA. |

## Phase gate

| # | Gate | Evidence | Result |
|---|---|---|---|
| 1 | Trade-data threaded into `ReceiptModal` | `apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx` calls `orderBookApi.getTrades({ orderUid: order.id }, { chainId })` when order status is `OrderStatus.FULFILLED`; passes the first trade into `DownloadReceiptButton.input.trade`. Cowswap build passes. Commit `1dd351cd1`. | PASS |
| 2 | SVG icon variant for Safe app store | `apps/cowswap-frontend/public/greg-icon.svg` (256×256, rounded square + "G"). Manifest `iconPath: /greg-icon.svg`. Build artifact at `build/cowswap/greg-icon.svg` confirmed. Commit `e80612f47`. | PASS |
| 3 | DCA top-level CTA on home page | `apps/cowswap-frontend/src/pages/Swap/index.tsx` — `<InlineBanner>` with `NavLink` to `/advanced`, mounted via `<SwapWidget topContent>` prop. Same component pattern as upstream's `TwapSuggestionBanner`. Commit `a2bab8373`. | PASS |
| 4 | Multisig partner-fee recipient deployed and live in code | `packages/sdk/src/partner-fee.ts` + `apps/cowswap-frontend/src/greg/partnerFeeDefault.ts` both reference `0x858f0F5e…CeF8`. 7 sdk tests pass; cowswap build green. Commit `c5f54f06f`. | PASS |
| 5 | Production Vercel deploy + correct SSO state | Production target serves HTTP 200 (public) on `greg-clementfrmds-projects.vercel.app` and `greg-git-main-clementfrmds-projects.vercel.app`. Preview deployments serve HTTP 401 (team-gated) — `ssoProtection.deploymentType: "preview"`. Vercel git-connect made every push to main a production deploy automatically. | PASS |
| 6 | Safe-list PR open against `safe-global/safe-apps-list` | **DEFERRED** — public action under Clement's GitHub identity; pending operator go-ahead. Submission package ready in `docs/development/safe-app-submission.md`. | DEFERRED |
| 7 | Show HN draft committed | `docs/development/show-hn-draft.md` — title options, body, pre-staged OP follow-up, Q&A bank, timing notes. Commit `2a7b6a607`. | PASS |
| 8 | Product Hunt draft committed | `docs/development/product-hunt-draft.md` — taglines, description, media checklist, maker comment, timing. Commit `58bb708d6`. | PASS |

## Phase 2.5 verdict: PASS (with one deferred operational task)

Engineering substrate complete. Greg is publicly accessible at the Vercel production aliases. Partner-fee meter runs on every swap, routed to a Gnosis Safe. MEV-proof receipt downloads now include settlement tx hash + block for fulfilled orders. DCA discoverable from the home page. SVG icon ready for Safe app store. Show HN + Product Hunt posts drafted.

**One open operational task:** the Safe-list PR (Task 8) is a public commitment under Clement's GitHub identity and waits for explicit go-ahead. The submission package is ready — opening the PR is a 5-minute task whenever Clement says fire.

## Operational snapshot for Phase 3 (MegaETH fork-deploy)

- Repo: `san-npm/greg` (private), tagged `v0.2.5-phase2-5`.
- Frontend: cowswap fork at upstream SHA `0174f35e7…`; Greg patches tracked in `apps/frontend/.greg-divergences.md`.
- Backend: cowprotocol/services subtree at upstream SHA `0720b9bc1…` (vendored in Phase 1). Production runtime for Phase 3 MegaETH deployment.
- Partner-fee recipient: Safe `0x858f0F5e…CeF8` on Gnosis (lazy-deploy on other chains as fees accrue). Threshold 1-of-1 — upgrade before significant accrual.
- Live URL: https://greg-clementfrmds-projects.vercel.app (production, public).
- CoW supported chains where Greg's partner-fee fires today: Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Linea, Plasma, Ink, Gnosis. Plus Sepolia for testnets.

## Open follow-ups (parked, not blocking)

- **Real brand + domain.** Phase 2.6 mini-plan when a name + domain decision lands.
- **Multisig threshold upgrade.** Before first material partner-fee disbursement (CoW pays out weekly when ≥ 0.001 WETH accrues).
- **Safe-list PR submission.** Clement's call when ready.
- **Show HN / Product Hunt posts.** Clement's call on timing; drafts ready.
- **Greg-styled receipt PDF template.** Currently plain monospace; brand work later.
- **Mobile PWA install verification.** Once a stable real domain exists.
- **Embed widget productisation.** Phase 4.
- **First weekly WETH payout watch.** Set up a small monitor (cron + curl + Telegram) on the recipient address to alert when CoW DAO disburses. Useful as social-proof content for Phase 3 launch.

## Next phase

[Phase 3 — MegaETH fork-deploy](https://github.com/san-npm/greg/issues/4). Calendar Jun 1–21. Deploy CoW's audited GPv2Settlement + GPv2VaultRelayer bytecode unchanged on MegaETH (chainId 4326) under our own AllowListAuthentication. Become the chain-native intent broker on a chain CoW has not deployed to. The vendored services stack from Phase 1 is the production runtime.
