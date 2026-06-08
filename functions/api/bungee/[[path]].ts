/**
 * Server-side proxy for Bungee bridge API calls (Ophis dedicated integrator).
 *
 * WHY: to charge Ophis's own bridge fee, Bungee's dedicated tier requires an
 * `x-api-key` header, and Bungee's docs mandate it stay SERVER-SIDE (never in
 * the browser bundle, where it could be extracted / rate-limit-drained). So the
 * frontend bridging SDK points its Bungee `apiBaseUrl` at this same-origin
 * proxy; we inject the key here and forward to Bungee. The integrator feeBps is
 * configured in the Bungee dashboard (bound to the key), not passed per-request.
 *
 * SAFE BY DEFAULT: if `BUNGEE_API` is unset, we forward WITHOUT the key, so the
 * proxy degrades to plain affiliate-attribution behavior rather than breaking
 * bridge quotes. The upstream host is `BUNGEE_BACKEND` (default the standard
 * backend, which works keyless); set it to the dedicated backend once the
 * dedicated integrator is confirmed with Bungee.
 *
 * Routing: CF Pages catch-all. /api/bungee/<rest> -> ${BUNGEE_BACKEND}/<rest>,
 * method + query + body forwarded verbatim. Same-origin (called only from
 * swap.ophis.fi), so no CORS handling is needed.
 *
 * ACTIVATION (not live until all of):
 *   1. BUNGEE_API set as a Cloudflare Pages runtime secret (NOT just a GitHub
 *      Actions secret — CF Functions read the Pages project env at runtime).
 *   2. BUNGEE_BACKEND set to the confirmed dedicated host (if it differs).
 *   3. The frontend built with REACT_APP_BUNGEE_DEDICATED_ENABLED=true so the
 *      SDK routes through this proxy.
 *   4. A live bridge-quote test confirming the fee accrues to the Safe.
 */

interface Env {
  /** Bungee dedicated-integrator API key (Cloudflare Pages runtime secret). */
  BUNGEE_API?: string
  /** Upstream Bungee host. Default = the standard backend (keyless-safe). */
  BUNGEE_BACKEND?: string
}

const DEFAULT_BACKEND = 'https://backend.bungee.exchange'

// Forward only safe request headers; the `affiliate` id arrives from the SDK
// and is public, so it is passed through. Hop-by-hop / host / cookie headers
// are intentionally dropped.
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'affiliate']

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const url = new URL(request.url)

  // Strip the /api/bungee prefix to recover the upstream path.
  const rest = url.pathname.replace(/^\/api\/bungee/, '') || '/'
  const backend = (env.BUNGEE_BACKEND || DEFAULT_BACKEND).replace(/\/+$/, '')
  const upstream = `${backend}${rest}${url.search}`

  const headers = new Headers()
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(h)
    if (v) headers.set(h, v)
  }
  // Inject the dedicated key server-side. Absent -> keyless passthrough.
  if (env.BUNGEE_API) headers.set('x-api-key', env.BUNGEE_API)

  const init: RequestInit = { method: request.method, headers }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  let upstreamResp: Response
  try {
    upstreamResp = await fetch(upstream, init)
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'bungee upstream unreachable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Pass through status + body; only forward content-type (no upstream secrets/headers).
  const respHeaders = new Headers()
  const ct = upstreamResp.headers.get('content-type')
  if (ct) respHeaders.set('content-type', ct)
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: respHeaders })
}
