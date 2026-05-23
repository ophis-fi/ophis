/**
 * Host-aware path rewrite for Ophis subdomains.
 *
 * Lets docs.ophis.fi and business.ophis.fi serve their static landing
 * pages AT THE ROOT (URL stays /), instead of bouncing the visitor to
 * /docs/ or /business/ via a client-side window.location.replace. The
 * "/docs/" extension is a build-artefact of co-locating those pages
 * under apps/frontend/apps/cowswap-frontend/public/{docs,business}/
 * within the SPA's deploy bucket — visitors should never see it.
 *
 * Runs as Cloudflare Pages middleware (functions/_middleware.ts). All
 * non-matching hostnames + non-root paths flow through context.next()
 * so behavior elsewhere is unchanged.
 *
 * Other paths on the subdomain (e.g. docs.ophis.fi/llms.txt,
 * docs.ophis.fi/openapi.yaml) intentionally do NOT get prefixed:
 * those files live at the bucket root and are served identically
 * across hostnames. Only the bare `/` is rewritten.
 *
 * Why a Pages Function (not _redirects)? `_redirects` only produces
 * HTTP redirects — it cannot perform a same-URL internal rewrite.
 * env.ASSETS.fetch() returns the static asset at the rewritten path
 * while keeping the address bar pointing at /.
 */

interface Env {
  ASSETS: Fetcher
}

const SUBDOMAIN_TO_PATH: Record<string, string> = {
  'docs.ophis.fi': '/docs/',
  'business.ophis.fi': '/business/',
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const target = SUBDOMAIN_TO_PATH[url.hostname]
  if (target && url.pathname === '/') {
    const rewritten = new URL(url)
    rewritten.pathname = target
    return context.env.ASSETS.fetch(new Request(rewritten.toString(), context.request))
  }
  return context.next()
}
