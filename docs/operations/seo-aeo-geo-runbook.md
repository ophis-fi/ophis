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
| `sitemap.xml` | yes | yes (root-only by design) | yes (auto; `/search` excluded) |
| `llms.txt` | yes | yes | yes (+ build-generated `llms-full.txt`) |
| OG + Twitter meta | yes | yes | yes |
| Meta description | yes | yes | yes |
| Canonical | yes | per-route follow-up | yes (Docusaurus) |
| JSON-LD | Organization + WebSite sitewide; SoftwareApplication + SDK HowTo home-only; FAQPage (home); BlogPosting (posts) | Organization + WebApplication (added) | Organization (added) + per-page BreadcrumbList |
| IndexNow | yes (pinged on main deploys by `landing-deploy.yml`, non-fatal) | no | no |
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

> **The two gtag CSP console violations are EXPECTED, and must not be "fixed"
> by whitelisting (diagnosed 2026-08-01).** Every page on `ophis.fi` logs two
> `script-src-elem` violations. They are NOT ours: Cloudflare's Google Tag
> Gateway rewrites the HTML at the edge and injects two inline scripts, into
> browser-like requests only (a plain `curl` gets 91,129 bytes, a Chrome UA gets
> 91,545). They are absent from `dist/`, which is why `check-csp-hashes` passes
> while production violates.
>
> Blocking them is correct. They duplicate, and pre-empt, the consent-aware
> block in `Base.astro`: CF's pair runs first and calls
> `gtag('config','G-NG9YX5G9CM')` with **no consent defaults and no
> `anonymize_ip`**. Allowing them would double-count every `page_view` and set
> analytics cookies for EEA visitors before opt-in. GA4 is verified working
> today without them (at the time: gtag.js from `/938g`; now from
> googletagmanager.com per PR #1048 - either way `dataLayer`
> populates, a `collect` beacon fires after Accept).
>
> `scripts/check-csp-hashes.mjs` refuses any inline hash not produced by a
> script in `dist` (sha256/384/512), and any `'unsafe-inline'` in the directive
> that governs script elements. Covered by `scripts/test-csp-guard.mjs`.
>
> **To clear the console:** disable **Google tag gateway** on the `ophis.fi`
> zone in the Cloudflare dashboard. It is not exposed on any API, so it needs
> the dashboard.
>
> ⚠️ **Superseded 2026-08-01:** an earlier version of this note said to keep the
> `/938g` proxy because `Base.astro` loaded gtag.js through it. That is no
> longer true - PR #1048 pointed all three surfaces back at
> `googletagmanager.com`, so nothing depends on `/938g` and the zone feature can
> be turned off outright. Disable the whole thing; there is no part worth
> keeping (see the REMOVED note in the analytics section below for why).

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

REMOVED (2026-08-01): Cloudflare **Google Tag Gateway** was enabled on the
ophis.fi zone from 2026-06-07 (endpoint `/938g`, measurementId G-NG9YX5G9CM) and
has been backed out. All three surfaces now load gtag.js from
`https://www.googletagmanager.com/gtag/js?id=...` again, which every CSP already
allowed (the allowances had been kept as fallback), so no header change was
needed beyond rotating the landing's inline-script hash.

Why it was removed, in the order it was discovered:
1. Its edge HTML rewriting injected **two inline scripts** into browser-like
   requests only (plain `curl` 91,129 bytes vs Chrome UA 91,545), which never
   appear in `dist/` and so were invisible to CI while producing two
   `script-src-elem` violations on every page in production.
2. Those scripts were a **duplicate, consent-unaware GA4 setup**: they ran
   BEFORE the block in `Base.astro` and called
   `gtag('config','G-NG9YX5G9CM')` with no consent defaults and no
   `anonymize_ip`. Had anyone silenced the console by whitelisting their hashes,
   the result would have been double-counted `page_view`s and analytics cookies
   set for EEA visitors before opt-in. `check-csp-hashes.mjs` now refuses any
   inline hash not produced by a script in `dist`, so that fix is unavailable.
3. The benefit it was adopted for **was not being delivered**: measurement on
   2026-08-01 showed `collect` beacons going to `region1.google-analytics.com`,
   not through `/938g`. Only the gtag.js fetch was ever first-party. Pushing the
   `google_tags_first_party` marker from our own code did not change the
   transport, so this was not a side-effect of the CSP block.

Trade-off accepted: the gtag.js *fetch* is third-party again, so a blocker that
blocks googletagmanager.com will block it. That was already true of the beacons,
which is the larger half.

⚠️ **The zone toggle is dashboard-only.** There is no API for it: it is absent
from `/zones/{id}/settings` and every plausible route
(`google_tag_gateway`, `gtg`, `zaraz/config`, `tag_gateway`, `first_party_tags`,
account-level included) returns 400. Turn it off in the Cloudflare dashboard
AFTER this code is deployed - doing it first would 404 `/938g/gtag/js` and break
GA4 on all three surfaces until the deploy landed.

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

### Acquisition funnel events (wired 2026-09-02)

The landing and swap app now emit one privacy-safe funnel into the shared GA4
property. No wallet address, order UID, transaction hash, token address, amount,
email, or free-form intent text is sent.

| Event | Emitted when | Surface |
| --- | --- | --- |
| `trade_click` | A visitor follows any `swap.ophis.fi` link | Landing |
| `integration_click` | A visitor follows an Ophis docs, MCP, business, SDK, or repository link | Landing |
| `wallet_connect` | The app transitions to a connected wallet | Swap |
| `quote_received` | A new input state receives its first optimal quote; polling refreshes are deduplicated | Swap |
| `swap_initiated` | The user starts the trade flow | Swap |
| `order_submitted` | The posted-order event fires after successful creation | Swap |
| `order_filled` | The order-status updater observes fulfillment | Swap |

**GA4 key-event classification is property state, not website code.** On
2026-09-02, `order_submitted` and `order_filled` were created in the Ophis GA4
property (`properties/540148539`) with **Once per event** counting and verified
through the Analytics Admin API. Optionally add `wallet_connect` as a secondary
key event with **Once per session** counting. Do not mark `trade_click`,
`integration_click`, `quote_received`, or `swap_initiated` as key events; they
are diagnostic funnel steps rather than completed business outcomes.

This can also be automated through `properties.keyEvents.create` in the Google
Analytics Admin API, but it requires the numeric GA4 property ID and an OAuth
principal with the `analytics.edit` scope. The measurement ID alone is not
enough.

## Follow-ups (no operator input needed, scoped separately)

- **Swap per-route canonical + meta.** The swap is a client-rendered SPA; a
  static canonical in `index.html` would wrongly point every route at the root.
  Wire `react-helmet-async` to emit a per-route canonical + title/description.
- **Swap/business `sitemap.xml` host-specific (done).** Per the Sitemaps
  protocol (every URL must be same-host as the sitemap file), the one Pages
  deploy serves each host its OWN same-host sitemap: `swap.ophis.fi` gets the
  static `public/sitemap.xml` (root URL only; hash routes are invisible to
  crawlers) via `context.next()`; `business.ophis.fi` gets a generated
  business-only sitemap + robots (now with the full AI-crawler allowances +
  Content-Signal, matching the other hosts) from `functions/_middleware.ts`.
  The non-standard `Host:` robots directive was dropped. The landing
  (`ophis.fi`) is a separate deploy with its own sitemap.
- **Canonical-host question: CLOSED (2026-07-03).** The marketing routes no
  longer resolve as paths on `ophis.fi` (`/about`, `/legal`, `/brand`, `/learn`
  return 404 on the apex); they live only under `swap.ophis.fi/#/...` hash
  routes, which crawlers do not fetch. There is no live duplicate-content
  surface between the hosts.

## Changelog

- **2026-07-03 (swap Soft-404 root-cause fix):** Search Console reported swap.ophis.fi (and its hash routes) as Soft 404. Two causes fixed: (1) the SPA HTML fallback answered missing hashed-asset paths (deploy-propagation windows) with the one-year immutable header attached by path, so browsers and Googlebot cached HTML-as-JavaScript and every later render died at the static shell; functions/_middleware.ts now returns a real no-store 404 for asset-shaped paths that would fall back to HTML. (2) The crawler-visible shell ended with "Loading the app...", a textbook soft-404 trigger; replaced with a content line. After deploy: URL-inspect https://swap.ophis.fi/ in GSC and Request indexing. Hash-fragment rows (#/...) can never be indexed separately and inherit the root verdict; treat them as noise.
- **2026-07-03 (SEO/AEO hygiene sweep):** swap `llms.txt` app-route links fixed
  to `swap.ophis.fi/#/...` (they pointed at the hash-less apex, so agents and AI
  crawlers following them landed on the wrong page), chain list refreshed to
  the 12 live networks (Unichain added; the swap SEO block's stale HyperEVM
  mention removed), Unichain orderbook host (`unichain-mainnet.ophis.fi`)
  documented, `/#/affiliate` route listed, operator email added; business
  robots.txt aligned with the other hosts (AI crawlers + Content-Signal); docs
  sitemap excludes `/search`; docs build now generates `llms-full.txt` (linked
  from every `llms.txt`); landing JSON-LD split (Organization + WebSite
  sitewide, SoftwareApplication + SDK HowTo home-only, X profile added to
  `sameAs`); landing footer links Rebates + Business.
