/**
 * Host-aware routing for Ophis on the primary Pages project (greg).
 *
 * 1. business.ophis.fi serves its static landing page AT THE ROOT (URL
 *    stays /). The page lives under public/business/ within the SPA's
 *    deploy bucket; visitors should never see the /business/ path. We use
 *    a same-URL internal rewrite (env.ASSETS.fetch) rather than
 *    _redirects, which can only issue HTTP redirects, not rewrites.
 *
 * 2. The old on-domain docs are retired: docs now live in their own Pages
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

const SUBDOMAIN_TO_PATH: Record<string, string> = {
  'business.ophis.fi': '/business/',
}

const DOCS_PORTAL = 'https://docs.ophis.fi/'

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)

  // Retired static docs: 301 the old apex /docs path to the new portal.
  if (
    (url.hostname === 'ophis.fi' || url.hostname === 'www.ophis.fi') &&
    (url.pathname === '/docs' || url.pathname.startsWith('/docs/'))
  ) {
    return Response.redirect(DOCS_PORTAL, 301)
  }

  const target = SUBDOMAIN_TO_PATH[url.hostname]
  if (target && url.pathname === '/') {
    const rewritten = new URL(url)
    rewritten.pathname = target
    return context.env.ASSETS.fetch(new Request(rewritten.toString(), context.request))
  }
  return context.next()
}
