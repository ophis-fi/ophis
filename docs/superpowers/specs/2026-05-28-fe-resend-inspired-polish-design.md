# Ophis FE polish — resend-inspired landing + app micro-interactions

> **Date:** 2026-05-28
> **Owner:** Clement (san-npm)
> **Status:** Design approved; implementation plan to follow
> **Brainstorm session:** `.superpowers/brainstorm/56174-1779984785/` (gitignored)

## 1. Summary

Build a new Ophis landing page at `ophis.fi/` that adapts resend.com's design pattern (dark theme + warm accent + restrained scroll-rhythm + code-forward content) to Ophis's brand (saffron palette, claw mark, agent-trading positioning). Add three small motion treatments to the existing swap app (`cowswap-frontend`) so the two surfaces feel consistent. Both must hit a strict performance budget (LCP < 1.5s, INP < 100ms, CLS 0.0, < 100KB landing JS) since the next sub-project — SEO / AEO / GEO / AI agent discovery — depends on a fast, scrapable canonical surface.

## 2. Goals

- A landing at `ophis.fi/` that an agent or developer can land on, understand what Ophis is in under 10 seconds, and either launch the app or read the docs.
- Visual + motion consistency between landing and swap app: same palette, same nav blur, same CTA treatment.
- Static, fast, SEO/AI-friendly markup (semantic HTML, schema.org-ready, no JS-required content).
- Zero new sensitive data exposure: no API keys, no internal endpoints, no operator-only addresses in any published artifact.

## 3. Non-goals (explicitly out of scope)

- WebGL, Three.js, or Spline 3D scenes (perf budget forecloses)
- Customer logos, testimonials, or volume metrics (don't have the content yet)
- Blog or changelog section (next sub-project's territory)
- Form-field focus animations, page-transition animations, loading skeletons in the app (user skipped)
- Touching the existing swap CF Pages project's `.pages.dev` references — those are a deliberate 30-day cushion expiring 2026-06-10, tracked in the `project_greg_etm_url_cushion` Claude memory. The landing must NOT introduce new `.pages.dev` references for the swap project.

## 4. Architecture

### 4.1 New Astro app

New workspace member at `apps/frontend/apps/ophis-landing/`. Astro chosen over Next.js because:

- Strict perf budget. Next.js framework JS is ~80KB before any user code; Astro's floor is ~10KB.
- 6 of 7 sections are fully static. Only the code-tab switcher needs JS — perfect fit for Astro's "islands" model.
- Static-first SSG means content is in the HTML on first paint, no hydration jank for SEO crawlers or AI scrapers.

Project layout:

```
apps/frontend/apps/ophis-landing/
├── astro.config.mjs            # static output, Sharp for images, view-transitions off
├── package.json                # @ophis/landing, peer of cowswap-frontend
├── public/
│   ├── favicon.ico
│   ├── ophis-claw-saffron.svg  # symlinked or copied from brand assets
│   └── og-image.png            # 1200x630 social card (saffron logo on near-black)
├── src/
│   ├── components/             # .astro components (server-rendered, zero JS)
│   │   ├── Nav.astro
│   │   ├── Hero.astro
│   │   ├── ChainsStrip.astro
│   │   ├── CodeSection.astro
│   │   ├── FeatureGrid.astro
│   │   ├── SDKSection.astro
│   │   ├── BuiltOnStrip.astro
│   │   ├── FinalCTA.astro
│   │   ├── Footer.astro
│   │   └── Reveal.astro       # IntersectionObserver wrapper
│   ├── islands/                # interactive components (client:visible)
│   │   └── CodeTabs.tsx        # the only React island
│   ├── layouts/
│   │   └── Base.astro          # head, meta, OG tags, font preload, critical CSS
│   ├── lib/
│   │   ├── reveal.ts           # IO bootstrap, ~30 lines, vanilla
│   │   └── nav-blur.ts         # scroll listener, ~10 lines, vanilla
│   ├── pages/
│   │   └── index.astro         # the only page initially
│   └── styles/
│       ├── tokens.css          # imports from ../../../cowswap-frontend/src/ophis/tokens.ts via build step
│       └── global.css          # base styles, type ramp, motion keyframes
└── tsconfig.json
```

### 4.2 Routing

- `ophis.fi/` → the new landing (Cloudflare Pages project `ophis-landing`)
- `swap.ophis.fi` → the existing swap app (existing swap CF Pages project keeps serving its current build; we add a new custom domain to it: `swap.ophis.fi`)
- `docs.ophis.fi`, `explorer.ophis.fi`, `rebates.ophis.fi` — unchanged
- Soft-redirect on landing: if `localStorage.ophis_wallet_connected === 'true'` is set (we add this flag to the swap app on first wallet connect), the landing's `<head>` includes a `<meta http-equiv="refresh">` to `https://swap.ophis.fi/`. New visitors and search engines see the landing; returning traders bounce to the app.

### 4.3 DNS + Pages setup

- New CF Pages project: `ophis-landing`, custom domain `ophis.fi` + `www.ophis.fi`
- Existing swap CF Pages project: add custom domain `swap.ophis.fi`. Keep the swap project's `.pages.dev` URL alive until 2026-06-10 per the documented cushion.
- DNS via CF API token already in keychain (`cloudflare-api-token`).

### 4.4 Brand tokens — single source of truth

Ophis brand tokens live in `apps/frontend/apps/cowswap-frontend/src/ophis/tokens.ts`. The landing reads the same source via a tiny build-time codegen step (`scripts/tokens-to-css.mjs`, ~30 lines of Node) that runs in the landing's `prebuild` and emits `apps/frontend/apps/ophis-landing/src/styles/tokens.css` with CSS custom properties. The generated file is gitignored; the source is the only thing humans edit.

If tokens change in cowswap-frontend, the landing inherits on the next build. No copy-paste of hex codes.

## 5. Visual design system

| Token | Value | Use |
|---|---|---|
| `--ophis-saffron-60` | `#f2a63e` | Primary action, accent word, brand mark |
| `--ophis-saffron-30` | `#ffd09a` | Accent gradient endpoint |
| `--ophis-bg` | `#0a0a0a` | Page background |
| `--ophis-fg` | `#ffffff` | Headlines |
| `--ophis-fg-muted` | `rgba(255,255,255,0.65)` | Body |
| `--ophis-fg-faded` | `rgba(255,255,255,0.4)` | Captions |
| `--ophis-surface` | `rgba(255,255,255,0.02)` | Card fill |
| `--ophis-border` | `rgba(255,255,255,0.08)` | Card border |

**Type:** Geist (already brand-locked, subsetted at build time).

- Display 1: 64px / 600 / -0.02em
- Display 2: 40px / 600 / -0.02em
- Body: 17px / 1.5
- Mono (code): JetBrains Mono 13px / 1.6

**Spacing rhythm:** 80px vertical between sections (mobile: 56px). Max content width 1200px.

## 6. Section content map

Seven sections, in order:

1. **Hero** — *"DEX aggregator for the agent era."* Pill: "Announcing the Ophis SDK →". Subhead positions agents + developers. CTAs: Launch app (primary, saffron) + Read docs (secondary, outline). Saffron claw on right.
2. **Chains strip** — *"Live on"* — Optimism (live), HyperEVM (paused), MegaETH (paused), Solana (via NEAR Intents), Bitcoin (via NEAR Intents). Greyscale opacity for paused chains, with a "paused" caption.
3. **Trade tonight** — *"Trade tonight."* with accent on "tonight." Subhead: API description. Code block with curl / JavaScript / Rust tabs. Default tab: curl. Sample is a POST to `https://ophis.fi/api/intent` with a swap intent.
4. **Feature grid** — *"Built for real flow."* Three cards: MEV protection · Volume-tier rebates · Agent-safety SDK. Each card: icon + name + 2-sentence description.
5. **SDK section** — *"Ship integrations in an afternoon."* with `@ophis/sdk` tag. Left: copy + CTAs ("npm i @ophis/sdk" / "View on GitHub"). Right: code block showing `configurePartnerFee()`.
6. **Built on** — *"Built on the rails DeFi already trusts."* Stack: CoW Protocol · Foundry · Alloy · Cloudflare Pages · OP Stack.
7. **Final CTA + footer** — *"Aggregation reimagined. Available today on Optimism."* CTAs again. Footer with 4 columns: Product / Developers / Resources / Connect.

Exact copy in the wireframe (`.superpowers/brainstorm/56174-1779984785/content/full-landing-wireframe.html`). Implementation reads copy from `src/content/sections.ts` for future i18n hooks (lingui later).

## 7. Motion vocabulary

### 7.1 Landing (CSS + IntersectionObserver only — no motion library)

| Primitive | Where | How |
|---|---|---|
| `reveal-up` | Every section's content blocks | IO callback adds `.in-view` class → CSS transitions `opacity 0→1` + `translateY 30px→0`, 300ms ease-out |
| `stagger` | Cards in feature grid, chains in strip | nth-child delays (80ms or 120ms) |
| `nav-blur` | Sticky nav | Scroll listener toggles `.scrolled` class at scroll > 40px → CSS `backdrop-filter: blur(12px)` |
| `claw-rotate` | Hero anchor | Inline SVG, `@keyframes spin 40s linear infinite`. Paused via `@media (prefers-reduced-motion: reduce)` |
| `gradient-shimmer` | Accent words | `background-position` animation, 8s ease-in-out infinite. Paused via prefers-reduced-motion |

Bootstrap JS budget: `reveal.ts` + `nav-blur.ts` together ~50 lines, <2KB. The React island for code tabs adds ~12KB (Preact-compat React + tab logic). Total client JS budget for landing: <20KB. Well under the 100KB ceiling.

### 7.2 App (cowswap-frontend) — uses existing `framer-motion`

| Primitive | Where | How |
|---|---|---|
| `nav-blur` | App header | Same CSS approach as landing (consistency primitive lives in `src/ophis/motion/nav-blur.css`) |
| `cta-press` | All primary buttons | CSS `scale(0.97)` on `:active`, soft saffron `box-shadow` on `:hover`. Applied via a `<PrimaryButton>` wrapper or a shared class on existing buttons |
| `toast-slide` | Toast container | `AnimatePresence` from framer-motion already imported. Wrap toasts in `<motion.div>` with slide-from-top-right + fade |

App motion adds zero new deps (framer-motion already in `apps/frontend/apps/cowswap-frontend/package.json`).

## 8. Performance budget (gated in CI)

Hard targets, measured by Lighthouse CI on every PR touching `apps/frontend/apps/ophis-landing/**`:

- **LCP** < 1.5s (95th percentile, mobile 4G throttling)
- **INP** < 100ms
- **CLS** = 0.0
- **JS** < 100KB gzipped (all routes)
- **Total page weight** < 500KB

Techniques used:

- Astro static output, no SSR runtime
- Critical CSS inlined into the HTML `<head>`
- Geist font subsetted to Latin glyphs only, `<link rel="preload">` with `crossorigin`, `font-display: swap`
- Claw SVG inlined into the hero (LCP element has zero network cost)
- All images: WebP with PNG fallback, dimensions in attributes (no CLS)
- No third-party scripts (no analytics, no chat widgets, no tag managers)

Lighthouse CI config: `apps/frontend/apps/ophis-landing/.lighthouserc.json`.

## 9. Routing & deployment

### 9.1 Deploy workflow

New workflow `.github/workflows/landing-deploy.yml`:

- Triggers on push to `main` when files in `apps/frontend/apps/ophis-landing/**` change.
- Steps: install (pnpm), build (`pnpm --filter @ophis/landing build`), Lighthouse CI budget check, wrangler pages deploy to project `ophis-landing`.
- Sanitized `--commit-message` per the `feedback_cf_pages_ascii_commit_message` memory — never let wrangler auto-read git HEAD (em-dashes break CF Pages deploys with error 8000111). The workflow strips non-ASCII bytes from `${{ github.event.head_commit.message }}` before passing to wrangler.

### 9.2 swap.ophis.fi cutover (zero-downtime ordering)

Strict ordering to avoid users hitting 404s during the transition:

1. **Add `swap.ophis.fi` to the existing swap CF Pages project's custom domains.** Verify DNS resolves + the swap UI loads at the new subdomain.
2. **Add `ophis_wallet_connected = true` localStorage write to the swap app's wallet-connect path.** Ship via the standard cowswap-frontend deploy. Real users start accumulating the flag.
3. **Deploy the landing to a *preview* URL** (CF Pages auto-generates `<branch>.ophis-landing.pages.dev`). Smoke-test the redirect logic + Lighthouse budget on staging.
4. **Promote landing to production by attaching `ophis.fi` to the `ophis-landing` project.** Cloudflare swaps the routing atomically — there's no period where `ophis.fi` is 404. The previous swap CF Pages project loses the `ophis.fi` domain at the same moment.
5. **Remove `ophis.fi` from the swap CF Pages project's custom domains** (cleanup; should already be detached after step 4 but verify).

Existing users with wallets: the landing's `<head>` includes a tiny inline `<script>` (synchronous, < 200 bytes) that reads `localStorage.ophis_wallet_connected`. If truthy, it does `window.location.replace('https://swap.ophis.fi/')` before the rest of the page renders. New visitors and search engines see the landing. The script runs before paint, so there's no flash of landing for returning users.

## 10. Testing strategy

### 10.1 Visual regression

Playwright screenshot tests in `apps/frontend/apps/ophis-landing/tests/visual.spec.ts`:

- Full-page screenshot at 1440x900 (desktop) and 390x844 (mobile)
- Per-section screenshots (hero, chains, code, features, sdk, built-on, final-cta)
- prefers-reduced-motion variant (claw not rotating, gradient not shimmering)

### 10.2 Performance regression

Lighthouse CI runs on every PR and the deploy workflow. Budget thresholds in `.lighthouserc.json` cause CI failure if exceeded.

### 10.3 a11y

axe-core run in Playwright tests. Targets WCAG 2.1 AA.

### 10.4 Redirect behavior

Playwright test: hit `ophis.fi/` with `localStorage.ophis_wallet_connected = true` → expect navigation to `swap.ophis.fi`.

### 10.5 Codex audit (pre-merge, MANDATORY)

Per the `reference_codex_cyber` and `feedback_audit_mainnet_contract_wiring` Claude memories: from the Claude session, invoke `mcp__plugin_second-opinion_codex__codex` against the PR diff before merging. **Do NOT pass a model override** per `feedback_codex_mcp_model_names` — Codex picks the right gpt-5.5 trusted-cyber variant automatically on Plus-tier accounts.

Codex audit scope for this PR specifically:

- Hardcoded secrets in the landing bundle (grep + Codex sweep)
- Internal endpoints leaked into the client bundle (Aleph VM IPs, `*.ts.net`, eRPC URLs)
- Insecure CSP or missing security headers
- XSS / unsafe innerHTML, unsafe target="_blank" without rel="noopener"
- Misconfigured CORS for the future `/api/intent` calls from the landing
- Soft-redirect logic: confirm it can't be abused to redirect to an attacker-chosen domain (the URL must be hardcoded literal `https://swap.ophis.fi/`, no template interpolation)

Additionally, per `feedback_check_codex_post_merge_review`: check `gh api pulls/N/comments` AFTER merge to catch any P1/P2 finding the post-commit Codex bot adds. The pre-merge MCP invocation does NOT see those.

## 11. Security considerations

The landing is a **PUBLIC, SSG-rendered, static asset bundle.** Anything in the build is visible to anyone. Hard rules:

1. **No API keys, no tokens, no secrets in client code.** The intent-API code example shows `curl` calls — these hit `https://ophis.fi/api/intent`, which is a Cloudflare Pages Function that already has its keys server-side. The example does not include any auth header.
2. **No internal endpoints.** No Aleph VM IPs, no eRPC private URLs, no Tailscale hostnames, no `*.ts.net` references.
3. **No operator-only addresses.** No driver submitter EOA, no Safe addresses (canonical settlement contract addresses are OK — they're public on-chain), no partner-fee recipient that isn't the published one.
4. **No personal data.** No Clement's email, no LinkedIn profile, no Telegram handle. Public contact is `clement@aleph.cloud` (already documented in SECURITY.md) — only surface that on the Security page when we have one, not the landing.
5. **CSP headers** set via `_headers` file (Cloudflare Pages syntax). v1 ships with hashed-script CSP (not nonces — they require SSR; we're SSG). Astro's `astro-compress` integration emits SHA-256 hashes for inlined scripts; we feed them into the CSP header at build time:
   - `default-src 'self'`
   - `script-src 'self' 'sha256-<...>'` (specific hashes for inlined bootstrap + redirect scripts; no `unsafe-inline`)
   - `style-src 'self' 'sha256-<...>'`
   - `img-src 'self' data:`
   - `font-src 'self'`
   - `connect-src 'self' https://swap.ophis.fi https://ophis.fi`
   - `frame-ancestors 'none'`
   - `form-action 'self'`
   - `base-uri 'self'`

   Inline-scripts are limited to: (a) the localStorage-check redirect (~150 bytes, hashed), (b) the reveal/nav-blur bootstrap (~1.5KB combined, hashed). Both ship as static literals — no template interpolation = stable hashes across builds.
6. **`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`** — set via `_headers`.
7. **No telemetry without explicit consent.** No GA, no Plausible, no Cloudflare Analytics opt-in by default. If we add it, it's behind a consent banner.
8. **Reproducible builds.** Lockfile committed. No `latest` tags. Dependabot watches the new app.

## 12. Existing-code constraints

- **Do NOT touch the swap CF Pages project's `.pages.dev` references in `cowswap-frontend`** — those are the deliberate 30-day cushion expiring 2026-06-10. The landing must not introduce any new ones.
- **Do NOT add Ophis-era brand strings.** The landing uses "Ophis" exclusively. Audit the spec content for any stale leftover terminology before commit.
- **Lingui compatibility.** Even though i18n isn't on for the landing initially, write strings in a way that's extractable later (e.g., constants in `src/content/sections.ts`).

## 13. Open questions

None at design-approval time. All decisions locked through the brainstorming session.

## 14. References

- Brainstorm session artifacts: `.superpowers/brainstorm/56174-1779984785/`
- Visual companion screens: `intro.html`, `hero-direction.html`, `section-structure.html`, `full-landing-wireframe.html`
- Resend.com analysis: `.superpowers/brainstorm/resend-hero.png` (full-page screenshot)
- Brand foundations: `docs/development/specs/2026-05-06-ophis-brand-foundations.md`
- Brand guidelines: `docs/development/specs/2026-05-07-ophis-brand-guidelines.md`
- Brand sheet: `docs/brand/sheet.html`
- Existing brand tokens: `apps/frontend/apps/cowswap-frontend/src/ophis/tokens.ts`
- Cushion to respect: `project_greg_etm_url_cushion` (Claude memory)
- ASCII commit-message requirement: `feedback_cf_pages_ascii_commit_message` (Claude memory)
