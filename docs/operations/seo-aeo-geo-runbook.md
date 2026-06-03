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

## Pending — needs operator action

### 1. Search Console / Bing / Yandex verification (preferred: DNS-TXT)

A single domain-property in each tool, verified by a **DNS TXT record on the
`ophis.fi` apex**, covers all three subdomains at once. Steps:

1. Operator creates the properties (Google Search Console, Bing Webmaster,
   Yandex Webmaster) as **domain** properties for `ophis.fi` and hands over the
   TXT verification strings.
2. Add each TXT record on the `ophis.fi` apex via the Cloudflare API. **Blocked
   until** the API token has **`Zone -> DNS:Edit` (records)** re-added — the
   recent token edit swapped it for `DNS Settings:Edit`, so the `dns_records`
   API currently returns an auth error.
3. Alternative (no DNS needed): meta-tag verification. Slots, if used instead:
   - landing: `src/layouts/Base.astro` `<head>`
   - swap: `index.html` `<head>` (or via react-helmet)
   - docs: `docusaurus.config.ts` `themeConfig.metadata`

### 2. Google Analytics 4

Needs the operator's GA4 Measurement ID(s) (`G-XXXXXXXXXX`). One ID can cover
all three, or use separate IDs per surface for cleaner segmentation. Wiring:

- **docs**: add `gtag: { trackingID: '<G-ID>', anonymizeIP: true }` to the
  `classic` preset options in `docusaurus.config.ts` (built-in; handles CSP).
- **swap**: the swap app deploys to **Cloudflare Pages**, so the enforced CSP is
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
- **Swap `sitemap.xml` host-consistent (done) + canonical host (still open).** The
  shared sitemap (served at both `swap.ophis.fi/sitemap.xml` and
  `business.ophis.fi/sitemap.xml` from the one Pages deploy) now lists the
  `swap.ophis.fi/*` content routes **plus** `business.ophis.fi/`, so each host's
  own pages are discoverable and it stays consistent with the shared
  `robots.txt` `Sitemap`/`Host` directives. The landing (`ophis.fi`) stays out (it
  is a separate deploy with its own sitemap). Still open: the marketing pages
  (`/about`, `/legal`, `/brand`, `/learn`) resolve on both `ophis.fi` and
  `swap.ophis.fi`; pick one canonical host per page and align each surface's
  sitemap + `rel=canonical` to it.
