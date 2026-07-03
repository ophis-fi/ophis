/**
 * Host-aware routing for Ophis on the primary Pages project (greg).
 *
 * 1. business.ophis.fi serves its static landing page AT THE ROOT (URL
 *    stays /). The page lives under public/business/ within the SPA's
 *    deploy bucket; visitors should never see the /business/ path. We use
 *    a same-URL internal rewrite (env.ASSETS.fetch) rather than
 *    _redirects, which can only issue HTTP redirects, not rewrites.
 *
 * 2. business.ophis.fi gets its OWN same-host robots.txt + sitemap.xml.
 *    The static public/{robots.txt,sitemap.xml} belong to swap.ophis.fi;
 *    serving them on business.ophis.fi would advertise cross-host URLs, which
 *    the Sitemaps protocol forbids (every URL in a sitemap must be on the same
 *    host as the sitemap file) and host-validating crawlers reject. swap.ophis.fi
 *    keeps the static files; business.ophis.fi's are generated here.
 *
 * 3. The old on-domain docs are retired: docs now live in their own Pages
 *    project at https://docs.ophis.fi (the former docs.ophis.fi rewrite
 *    here is gone). Any leftover /docs* request on the apex is
 *    301-redirected to the new portal so old links and search results
 *    don't dead-end.
 *
 * All other hostnames + paths flow through context.next() unchanged.
 */

interface Env {
  ASSETS: Fetcher
}

// business.ophis.fi is intentionally a SINGLE-PAGE host: only '/' serves content
// (rewritten to the static /business/ landing). It has no sub-path links of its
// own (its nav points at swap.ophis.fi / docs.ophis.fi / GitHub), and its sitemap
// below lists only '/'. Any other business.ophis.fi/* path falls through to the
// SPA unchanged; if sub-pages are ever added, give them /business/* assets + a
// rewrite here.
const SUBDOMAIN_TO_PATH: Record<string, string> = {
  'business.ophis.fi': '/business/',
}

const DOCS_PORTAL = 'https://docs.ophis.fi/'

const BUSINESS_ORIGIN = 'https://business.ophis.fi'

// business.ophis.fi same-host robots.txt: points at its OWN sitemap (not
// swap.ophis.fi's). No non-standard 'Host:' directive (a deprecated Yandex-only
// extension, redundant with the Sitemap directive + rel=canonical).
// Carries the same AI-crawler allowances + Content-Signal as the landing, swap,
// and docs robots.txt (AEO/GEO posture must be consistent across hosts).
const BUSINESS_ROBOTS = `User-agent: *
Allow: /
# Content Signals (contentsignals.org): public content, AI use welcome.
Content-Signal: ai-train=yes, search=yes, ai-input=yes

# Answer-engine / LLM crawlers explicitly allowed (AEO / GEO), matching the
# landing, swap, and docs policy.
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${BUSINESS_ORIGIN}/sitemap.xml
`

// business.ophis.fi same-host sitemap: the subdomain is a single indexable
// page (the institutional landing served at /).
const BUSINESS_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BUSINESS_ORIGIN}/</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)

  // Vite copies the app's own package.json into the deploy root. Served
  // verbatim it discloses dependency names + versions (an info-leak that
  // helps target known-CVE deps). This middleware runs before static asset
  // serving, so 404 the path on every host of this deploy (swap + business).
  if (url.pathname === '/package.json') {
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Retired static docs: 301 the old apex /docs path to the new portal.
  if (
    (url.hostname === 'ophis.fi' || url.hostname === 'www.ophis.fi') &&
    (url.pathname === '/docs' || url.pathname.startsWith('/docs/'))
  ) {
    return Response.redirect(DOCS_PORTAL, 301)
  }

  // business.ophis.fi: serve its own same-host robots.txt + sitemap.xml so the
  // shared deploy never advertises cross-host sitemap URLs. Must run before the
  // root rewrite below (these paths are not '/').
  if (url.hostname === 'business.ophis.fi') {
    if (url.pathname === '/robots.txt') {
      return new Response(BUSINESS_ROBOTS, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      })
    }
    if (url.pathname === '/sitemap.xml') {
      return new Response(BUSINESS_SITEMAP, {
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      })
    }
  }

  const target = SUBDOMAIN_TO_PATH[url.hostname]
  if (target && url.pathname === '/') {
    const rewritten = new URL(url)
    rewritten.pathname = target
    return context.env.ASSETS.fetch(new Request(rewritten.toString(), context.request))
  }

  // Never serve the SPA HTML fallback at asset-shaped paths. Pages' SPA
  // fallback answers ANY missing path with index.html, and _headers applies
  // cache rules BY PATH, so during a deploy-propagation window a missing
  // hashed bundle (e.g. /static/index-<hash>.js) is served as text/html WITH
  // the one-year immutable header. Browsers and Google's renderer then cache
  // HTML-as-JavaScript ~forever: the app dies at the static shell for that
  // client, which is exactly the "Soft 404" Google Search Console reports.
  // A real, uncacheable 404 makes every client (and crawler) simply retry.
  const assetLike =
    url.pathname.startsWith('/static/') ||
    (/\.[a-z0-9]{2,5}$/i.test(url.pathname) && !url.pathname.endsWith('.html'))
  if (assetLike) {
    const res = await context.next()
    if (res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')) {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return res
  }
  return context.next()
}
