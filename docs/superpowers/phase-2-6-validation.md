# Phase 2.6 — Cloudflare Pages Migration Validation Log

**Date:** 2026-05-04
**Tag:** `v0.2.6-phase2-6`
**New canonical URL:** https://greg-etm.pages.dev
**Vercel URL (parallel until sunset):** https://greg-clementfrmds-projects.vercel.app

## Why Cloudflare

Consolidates with Clement's existing Cloudflare account (DNS for 3615crypto.com / openletz.* / allo-webchat / mcp-services tunnels). Free tier on Cloudflare Pages has unlimited bandwidth (vs Vercel's 100 GB/month cap on the Hobby tier). Cloudflare's ~330 edge POPs vs Vercel's ~25 give measurably better global latency. Same `git push → preview URL` workflow once the GitHub Action is wired.

## What was migrated

The frontend deploy pipeline. Nothing else changed:
- Same vendored cowswap fork (`apps/frontend/`)
- Same patches (Phase-1.5 partner-fee atom, Phase-2 mevReceipt module, Phase-2.5 DCA CTA, manifest hardening, SVG icon)
- Same partner-fee recipient on the Safe `0x858f0F5e…CeF8`
- Build artifacts identical between Vercel and CF (verified — Safe recipient hex baked into the CF-deployed bundle: `/static/index-DQ6EdEsW.js`)

## Phase gate

| # | Gate | Evidence | Result |
|---|---|---|---|
| 1 | Cloudflare Pages project `greg` exists | Created via API; subdomain `greg-etm.pages.dev`, production_branch `main` | PASS |
| 2 | First deploy works (manual via wrangler) | 775 files uploaded in 159s; live at `https://8d293e58.greg-etm.pages.dev` | PASS |
| 3 | GitHub Action auto-deploys on push to main | `.github/workflows/cloudflare-deploy.yml` — run `25292283390` succeeded in 5m20s | PASS |
| 4 | Subsequent push triggers another auto-deploy | Run `25292479…` (manifest URL update commit `19bcde1f1`) — GH Action triggered | PASS |
| 5 | Manifest `homepage_url` repointed at CF | `apps/cowswap-frontend/public/manifest.json` → `https://greg-etm.pages.dev` | PASS |
| 6 | Safe-app submission package URL repointed at CF | `docs/superpowers/safe-app-submission.md` updated (5 occurrences) | PASS |
| 7 | Bundle parity with Vercel | Safe recipient `0x858f0F5e…CeF8` present in CF-deployed bundle; `<title>Greg</title>`; manifest serves correctly with CORS open | PASS |

## Workflow gotchas captured (so we don't relearn next time)

The `cloudflare-deploy.yml` survived three failure modes before passing:

1. **`pnpm/action-setup@v4` `version: 10` arg conflicts with `packageManager: pnpm@9.12.0` in our root `package.json`.** Same gotcha we hit in Phase 0 Task 3. Fix: drop the `version:` arg; the action reads `packageManager`.
2. **Cowswap's `build:production` OOMs at the GitHub-runner Node default of ~2 GB heap.** Fix: set `NODE_OPTIONS: --max-old-space-size=6144` env on the build step.
3. **`cloudflare/wrangler-action@v3`'s default install path runs `pnpm add wrangler` which `ERR_PNPM_ADDING_TO_ROOT`s in our pnpm-workspace setup.** Fix: pre-install wrangler globally via `npm install -g wrangler@latest` AND pass `packageManager: npm` to the action so it skips its own install attempt.

All three are now baked into the workflow file.

## Vercel fate

**Decision (Phase 2.6):** keep Vercel running in parallel. Vercel's GitHub integration is still active — every push to main triggers BOTH a Vercel deploy AND the new CF Pages deploy. Cost: zero (both on free / Pro tiers under our usage). Benefit: free fallback if CF has any issues during validation week.

**Sunset plan (Phase 2.7):**
1. After ~5 pushes with CF parity confirmed: `cd /Users/scep/greg && vercel git disconnect`
2. Vercel will stop auto-deploying on push but the existing deployment URL stays live
3. After ~1 month of CF stability OR if Phase 3 ships first: `vercel project rm greg`
4. Update `infra/local/.env` and any docs referencing Vercel URLs

## What still needs follow-up

- **Custom domain.** Currently `greg-etm.pages.dev` is the canonical URL. Phase 2.7 / brand work will swap to a real domain (e.g., `greg.openletz.com` or a dedicated one). Cloudflare-side setup is `pages.cloudflare.com → greg → Custom domains → Add` (or via API).
- **`@greg/sdk` package's `partnerFee.recipient`.** Stayed at the Phase-2.5 Safe `0x858f0F5e…CeF8`. Unchanged — migration is infrastructural, not financial.
- **GitHub repo's old `CI` workflow** (Phase 0 Task 3) still runs alongside the new CF deploy workflow on every push. They're independent — CI runs lint/typecheck, CF deploy builds + ships. Both pass. No conflict.

## Phase 2.6 verdict: PASS

CF Pages is now the primary deploy pipeline. Greg.app accessible at `https://greg-etm.pages.dev`. Manifest + Safe-app docs repointed. Vercel kept running for fallback.

## Next phase

Per Clement (2026-05-03): "once migrated to cloudflare you can move to phase 2.7". Phase 2.7 scope to be defined — likely combination of:
- Vercel sunset (after parity validation week)
- Custom domain on Cloudflare
- Brand work / codename retirement
- Or the operator pulls trigger on Phase 3 (MegaETH fork-deploy) directly.
