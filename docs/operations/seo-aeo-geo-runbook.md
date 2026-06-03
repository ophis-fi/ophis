# SEO / AEO / GEO runbook

How search, answer-engine, and generative-engine optimization is set up across
the three Ophis surfaces, what is live, and the exact steps to finish the
analytics + verification wiring once the operator hands over property IDs.

Surfaces: **landing** `ophis.fi` (Astro), **swap** `swap.ophis.fi`
(React/Vite SPA, CoW fork), **docs** `docs.ophis.fi` (Docusaurus).

## What is live

| Signal | Landing | Swap | Docs |
| --- | --- | --- | --- |
| `robots.txt` (+ AI crawlers allowed) | yes | yes (fixed: now points at swap.ophis.fi) | yes |
| `sitemap.xml` | yes | yes (see follow-up) | yes (auto) |
| `llms.txt` | yes | yes | yes |
| OG + Twitter meta | yes | yes | yes |
| Meta description | yes | yes | yes |
| Canonical | yes | per-route follow-up | yes (Docusaurus) |
| JSON-LD | Organization, WebSite, SoftwareApplication | Organization + WebApplication (added) | Organization (added) + per-page BreadcrumbList |
| GA4 (G-NG9YX5G9CM) | yes (Consent Mode denied) | yes (Consent Mode denied) | yes (Consent Mode denied) |
| Search engine verification | covered by ophis.fi apex DNS-TXT | covered by apex | covered by apex |

**AEO/GEO posture is already strong:** every surface allows the answer-engine
crawlers (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended,
etc.), ships an `llms.txt`, and exposes machine-readable discovery
(`/.well-known/ai-plugin.json`, `/.well-known/mcp.json`, `openapi.json`, the
hosted MCP server). The docs FAQ page carries `FAQPage` structured data. The
natural-language positioning is consistent across titles, descriptions, and
structured data.

> **Note on the inline JSON-LD + CSP (not a CSP issue):** the swap app's
> `<script type="application/ld+json">` is a non-executed *data block*. Per the
> HTML spec, a `<script>` whose `type` is not a JavaScript MIME type is never
> executed, so the CSP `script-src` inline-script check is never reached: data
> blocks are exempt from `script-src`. The element and its text remain in the DOM,
> and structured-data consumers (Googlebot, Rich Results) read its `textContent`
> regardless of CSP. **Verified on the live deploy** (under the enforced `_headers`
> CSP with no `unsafe-inline`/nonce/hash): the JSON-LD is present in the DOM, its
> `type` is `application/ld+json`, and `JSON.parse` of its content succeeds, with no
> CSP violation logged. So **no hash or nonce is needed** for the JSON-LD, and one
> should not be added. (A CSP linter that pattern-matches "inline `<script>` + no
> `unsafe-inline`" *without* checking `type` will report a false positive here.)
> Only **executable** scripts (e.g. external `gtag.js` and its inline bootstrap)
> require a `script-src` allowance.

## Done: analytics + verification (live as of 2026-06-03)

### 1. Search Console / Bing / Yandex verification (DONE)

- **Google Search Console + Bing Webmaster**: verified by the operator.
- **Yandex Webmaster**: verified via a DNS-TXT record on the `ophis.fi` apex,
  `yandex-verification: a34df2b7b99d0c54` (added via the Cloudflare API; the token
  now has `Zone -> DNS:Edit` records again). A domain property on the apex covers
  all subdomains. Meta-tag fallback slots, if ever needed: landing
  `src/layouts/Base.astro` `<head>`, swap `index.html` `<head>`, docs
  `docusaurus.config.ts` `themeConfig.metadata`.

### 2. Google Analytics 4 (DONE: G-NG9YX5G9CM, Consent Mode default-denied)

GA4 `G-NG9YX5G9CM` is wired on all three surfaces with **Consent Mode v2
default-denied**: `gtag('consent','default',{ad_storage,ad_user_data,
ad_personalization,analytics_storage: all 'denied'})` is queued **before**
`gtag('config')`, so GA4 runs cookieless (no analytics cookies / client-id
persistence) until consent is granted. `anonymize_ip` is also set. A future opt-in
banner can `gtag('consent','update',{analytics_storage:'granted'})` to upgrade to
full (cookied) measurement; until then GA reports limited/modeled data. As wired:

- **docs**: a MANUAL `headTags` setup in `docusaurus.config.ts` (NOT the preset
  `gtag` option, which can't guarantee consent-before-config ordering): one
  inline `<script>` doing dataLayer init -> consent default -> js -> config,
  placed BEFORE the async external `gtag.js` `headTags` entry so the synchronous
  inline runs first even from cache. `headTags` attribute values must be non-empty
  strings (e.g. `async: 'true'`) and each entry needs an `attributes` key. GA4
  Enhanced Measurement auto-tracks SPA route page-views (History events), so no
  Docusaurus route hook is needed. docs.ophis.fi has no CSP.
- **swap**: a BUNDLED module `src/ophis/analytics/initGa4.ts` (barrel
  `ophis/analytics`), called at the top of `initApp()` in `cow-react/index.tsx`.
  It is gated to `hostname === 'swap.ophis.fi'` (no preview/localhost noise),
  idempotent, sets consent-default then DOM-injects `gtag.js` (no inline
  `<script>`), then js + config. Added `https://www.googletagmanager.com` to
  `script-src` in `_headers` (beacons covered by `connect-src 'self' https:`).
- **landing**: an `is:inline` gated (`hostname === 'ophis.fi'`) gtag block in
  `Base.astro` doing consent-default -> DOM-inject gtag.js -> js + config. Its
  sha256 (from `scripts/check-csp-hashes.mjs`) is in `_headers` `script-src` along
  with `https://www.googletagmanager.com`; `connect-src` += GA endpoints, `img-src`
  += `*.google-analytics.com`. Re-run check-csp-hashes after any edit to the block.

OPEN follow-up (no operator input strictly needed): a minimal opt-in **consent
banner** to upgrade Consent Mode to `granted` (for full data) on the surfaces.

### (reference) swap CSP detail

The swap app deploys to **Cloudflare Pages**, so the enforced CSP is
  `apps/frontend/apps/cowswap-frontend/public/_headers`, **not** `vercel.ts` (the
  latter is the upstream CoW Vercel config and is not the deployed surface). The
  `_headers` `script-src` is `'self' 'wasm-unsafe-eval' 'unsafe-eval'
  https://challenges.cloudflare.com`, with **no `unsafe-inline`, nonce, or hash**.
  Two consequences for gtag, both must be handled:
    1. The **external** `gtag.js` is blocked until you add
       `https://www.googletagmanager.com` and `https://www.google-analytics.com`
       to `script-src` in `_headers`.
    2. The standard gtag **inline bootstrap** (`window.dataLayer = []; gtag('config', ID)`)
       is **also** blocked by the same CSP (it is an inline script element). Do
       **not** add an inline `<script>` for it. Instead either (a) load `gtag.js`
       and call `gtag(...)` from app TypeScript so there is no inline element
       (preferred), or (b) un-stub the existing **DOM-created** GTM path in
       `src/cow-react/index.tsx` (`initGtm()` appends a `<script src>` element
       programmatically, so it needs only the host allowance above, not an
       inline-script hash). A `react-helmet-async` external-`src` tag is fine; an
       inline config block is not (it would need its own sha256 hash in `_headers`).
  `connect-src` already allows `https:`, so the analytics beacons are fine. See
  `apps/frontend/.ophis-divergences.md` for the GTM-stub divergence.
- **landing**: add an inline gtag `<script is:inline>` in `Base.astro`, then
  regenerate the strict-CSP hash list (`scripts/check-csp-hashes.mjs`) and
  update `public/_headers` `script-src` (the landing CSP pins per-script
  sha256 hashes, so a new inline script needs its hash added).

## Follow-ups (no operator input needed, scoped separately)

- **Swap per-route canonical + meta.** The swap is a client-rendered SPA; a
  static canonical in `index.html` would wrongly point every route at the root.
  Wire `react-helmet-async` to emit a per-route canonical + title/description
  (the marketing pages `/about`, `/legal`, `/brand` resolve on both `ophis.fi`
  and `swap.ophis.fi`, so the canonical also resolves the duplicate-content
  question — pick one canonical host per page).
- **Swap/business `sitemap.xml` host-specific (done) + canonical host (still open).**
  Per the Sitemaps protocol (every URL must be same-host as the sitemap file), the
  one Pages deploy serves each host its OWN same-host sitemap: `swap.ophis.fi`
  gets the static `public/sitemap.xml` (swap-only URLs) via `context.next()`;
  `business.ophis.fi` gets a generated business-only sitemap + robots from
  `functions/_middleware.ts`. The non-standard `Host:` robots directive was
  dropped. The landing (`ophis.fi`) is a separate deploy with its own sitemap.
  Still open: the marketing pages (`/about`, `/legal`, `/brand`, `/learn`) resolve
  on both `ophis.fi` and `swap.ophis.fi`; pick one canonical host per page and
  align each surface's sitemap + `rel=canonical` to it.
