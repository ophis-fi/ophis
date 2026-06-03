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
- **swap**: inject gtag via `react-helmet-async` (already a dependency). The
  swap CSP (`vercel.ts`) already allowlists `googletagmanager.com` +
  `google-analytics.com`, so no CSP change is needed.
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
- **Swap `sitemap.xml` cross-domain.** It currently lists `ophis.fi/*` URLs
  while being served at `swap.ophis.fi/sitemap.xml`. Decide the canonical host
  for the marketing pages, then make each surface's sitemap list only its own
  same-host URLs.
