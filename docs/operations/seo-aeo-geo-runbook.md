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
| GA4 (G-NG9YX5G9CM) | yes (Consent Mode region-scoped + banner) | yes (region-scoped + banner) | yes (region-scoped + banner) |
| Search engine verification | GSC/Bing/Yandex via apex | GSC/Bing via apex; **Yandex per-host pending** | GSC/Bing via apex; **Yandex per-host pending** |

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

### 1. Search Console / Bing / Yandex verification (GSC + Bing DONE; Yandex apex done, subdomains PENDING)

- **Google Search Console + Bing Webmaster (DONE)**: verified by the operator as
  **domain** properties on `ophis.fi`, which cover every subdomain
  (swap/docs/business) automatically.
- **Yandex Webmaster — `ophis.fi` apex DONE; subdomains PENDING (operator action).**
  `ophis.fi` is verified via a DNS-TXT record on the apex,
  `yandex-verification: a34df2b7b99d0c54` (added via the Cloudflare API; the token
  now has `Zone -> DNS:Edit` records again). Unlike GSC/Bing **domain** properties
  (one apex verification covers every subdomain), Yandex Webmaster verifies each
  **site/host separately**, so:
    - **PENDING (operator):** add + verify `swap.ophis.fi`, `docs.ophis.fi`, and
      `business.ophis.fi` as separate sites in Yandex Webmaster. The same apex
      DNS-TXT is accepted as the verification method for each, but each host must
      still be added and verified individually; until then their Yandex indexing
      data is unowned.
  Meta-tag fallback slots, if ever needed: landing `src/layouts/Base.astro`
  `<head>`, swap `index.html` `<head>`, docs `docusaurus.config.ts`
  `themeConfig.metadata`.

### 2. Google Analytics 4 (DONE: G-NG9YX5G9CM, Consent Mode REGION-SCOPED + banner)

GA4 `G-NG9YX5G9CM` is wired on all three surfaces with **Consent Mode v2,
region-scoped**. Two `gtag('consent','default',...)` calls are queued **before**
`gtag('config')`: a global default with `analytics_storage:'granted'` (ads still
denied) so **rest-of-world is measured**, then an EEA/UK/CH-scoped override
(`region:[...]`, `wait_for_update:500`) with `analytics_storage:'denied'` so those
visitors stay **cookieless until they opt in**. `gtag.js` resolves the region from
Google's IP-geo, so no server-side lookup is needed. `anonymize_ip` is also set.

> **Why this changed (2026-06-07):** the previous global default-denied meant
> *every* visitor sent only cookieless pings. With no granted sessions, Consent
> Mode behavioural modeling can never train (it needs granted traffic), so GA4
> standard reports stayed at ~0 — the cause of the "0 traffic" incident. Region
> scoping restores full measurement for ROW while keeping the EEA compliant.

An **opt-in/opt-out consent banner** is shipped on all three surfaces (Accept →
`gtag('consent','update',{analytics_storage:'granted'})`, Decline → keep denied;
choice persisted in `localStorage['ophis_consent']` and re-applied on return,
overriding the regional default). EEA visitors (incl. the Luxembourg operator)
stay cookieless until they Accept. As wired:

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

Consent banner delivery per surface: **landing** extends the hashed `is:inline`
gtag block in `Base.astro` (DOM-built bar, re-run check-csp-hashes after edits);
**swap** ships a bundled `src/ophis/analytics/consentBanner.ts` (strict CSP — no
inline) mounted from `initGa4()`; **docs** uses a `clientModules` entry
(`src/consent-banner.ts`). All share the `localStorage['ophis_consent']` key.

DONE (2026-06-07): Cloudflare **Google Tag Gateway** (first-party tag serving)
is enabled on the ophis.fi zone, endpoint **`/938g`** (measurementId
G-NG9YX5G9CM, hideOriginalIp). All three surfaces load gtag.js from the
same-origin first-party path (`/938g/gtag/js?id=...`) instead of
googletagmanager.com; the CF-served gtag.js carries `transport_url=/938g`, so
the measurement beacons are first-party too — this is what recovers hits lost to
ad-blockers. Covered by each CSP's `'self'` (script-src + connect-src); the
googletagmanager.com / *.google-analytics.com allowances are kept for fallback.
The endpoint path is assigned by Cloudflare; if it ever rotates, update the
`/938g` literal in Base.astro, docusaurus.config.ts, and initGa4.ts.

### (reference) swap CSP, as implemented

The swap app deploys to **Cloudflare Pages**, so the enforced CSP lives in
`apps/frontend/apps/cowswap-frontend/public/_headers`, **not** `vercel.ts` (the
latter is the upstream CoW Vercel config and is not the deployed surface). As
shipped for GA4, `script-src` is `'self' 'wasm-unsafe-eval' 'unsafe-eval'
https://challenges.cloudflare.com https://www.googletagmanager.com` (still **no
`unsafe-inline`, nonce, or hash**). Two gtag constraints this design respects:

1. The external `gtag.js` loads because `https://www.googletagmanager.com` is in
   `script-src`; GA4 beacons to `*.google-analytics.com` are covered by
   `connect-src 'self' https:`.
2. There is deliberately **no inline gtag bootstrap** (an inline `<script>` would
   be blocked by this CSP). The bundled `src/ophis/analytics/initGa4.ts` module
   DOM-injects `gtag.js` and runs consent-default + config from app code instead.
   Any future inline `<script>` would need its own sha256 hash added to `_headers`
   (the landing already does this for its inline gtag). See
   `apps/frontend/.ophis-divergences.md` for the CoW-GTM-stub divergence.
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
