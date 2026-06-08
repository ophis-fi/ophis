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
interface MarkdownEnv {
  ASSETS: { fetch: (input: Request | string) => Promise<Response> }
}

// Explicit context type instead of `PagesFunction<Env>` so this file typechecks
// under the landing's `astro check` (which scans this dir but has no
// @cloudflare/workers-types). Cloudflare Pages still binds `onRequest` the same.
interface PagesMiddlewareContext {
  request: Request
  next: () => Promise<Response>
  env: MarkdownEnv
}

export async function onRequest(context: PagesMiddlewareContext): Promise<Response> {
  const { request, next, env } = context
  const accept = request.headers.get('accept') || ''
  const url = new URL(request.url)
  const lastSegment = url.pathname.split('/').pop() || ''
  // HTML page routes only: the root, trailing-slash routes, *.html, or any
  // extensionless path. Exclude /api/* (handled by the intent Function) and
  // anything that already has a file extension (assets).
  const isHtmlRoute =
    url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('.html') || !lastSegment.includes('.')

  if (request.method === 'GET' && accept.includes('text/markdown') && isHtmlRoute && !url.pathname.startsWith('/api/')) {
    try {
      const res = await env.ASSETS.fetch(new URL('/llms.txt', url.origin).toString())
      if (res.ok) {
        const body = await res.text()
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            // Rough token estimate (~4 chars/token), advisory for agents.
            'x-markdown-tokens': String(Math.ceil(body.length / 4)),
            'vary': 'Accept',
            'cache-control': 'public, max-age=300',
          },
        })
      }
    } catch {
      /* asset fetch failed: fall through to the normal HTML response */
    }
  }

  return next()
}
