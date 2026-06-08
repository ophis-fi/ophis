/**
 * Markdown-for-Agents content negotiation for the landing (ophis.fi).
 *
 * Cloudflare's managed "Markdown for Agents" is Pro/Business-gated and the zone
 * is on the Free plan, so we do the negotiation ourselves: a GET for an HTML
 * page with `Accept: text/markdown` returns the site's curated markdown summary
 * (the existing /llms.txt) as `Content-Type: text/markdown`, while browsers
 * (Accept: text/html) get the normal HTML. `Vary: Accept` keeps caches honest.
 *
 * This is the ONLY landing middleware: it deliberately does NOT include the
 * shared functions/_middleware.ts (which rewrites / -> /business/ for the swap
 * deploy). It is staged into the landing build by .github/workflows/landing-deploy.yml.
 */

// Explicit context type instead of `PagesFunction<Env>` so this file typechecks
// under the landing's `astro check` (no @cloudflare/workers-types). Cloudflare
// Pages binds `onRequest` the same.
interface PagesMiddlewareContext {
  request: Request
  next: () => Promise<Response>
}

const FALLBACK_MD =
  '# Ophis\n\n' +
  'Intent-based DEX aggregator (a CoW Protocol fork). Describe a swap in plain ' +
  'language, a solver network fills it MEV-protected, and you sign in your own ' +
  'wallet. Flat 0.10% (10 bps) fee on trade volume, 0.01% (1 bp) on stablecoin ' +
  'pairs.\n\nFull agent guide: https://ophis.fi/llms.txt\n'

export async function onRequest(context: PagesMiddlewareContext): Promise<Response> {
  const { request, next } = context
  const accept = request.headers.get('accept') || ''
  const url = new URL(request.url)
  const lastSegment = url.pathname.split('/').pop() || ''
  // HTML page routes only: root, trailing-slash, *.html, or any extensionless
  // path. Exclude /api/* (the intent Function) and asset paths (have an extension).
  const isHtmlRoute =
    url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('.html') || !lastSegment.includes('.')

  if (request.method === 'GET' && accept.includes('text/markdown') && isHtmlRoute && !url.pathname.startsWith('/api/')) {
    let body = FALLBACK_MD
    try {
      // Self-fetch the static /llms.txt (a .txt route, so this middleware's
      // markdown branch never matches it -> no recursion). text/plain Accept
      // also keeps it out of the markdown branch.
      const res = await fetch(new URL('/llms.txt', url.origin).toString(), { headers: { accept: 'text/plain' } })
      if (res.ok) {
        const text = await res.text()
        if (text) body = text
      }
    } catch {
      /* keep the inline fallback */
    }
    // Always return markdown when an agent asked for it: never fall through to HTML.
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'x-markdown-tokens': String(Math.ceil(body.length / 4)),
        vary: 'Accept',
        'cache-control': 'public, max-age=300',
      },
    })
  }

  return next()
}
