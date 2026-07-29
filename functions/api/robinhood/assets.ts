/**
 * GET /api/robinhood/assets
 *
 * Same-origin, cached facade for Robinhood's public Stock Token registry.
 * The first-party API intentionally does not emit browser CORS headers, so the
 * swap UI cannot consume it directly. This endpoint exposes only the documented
 * asset payload and fails closed if the upstream shape changes.
 */

const UPSTREAM = 'https://api.robinhood.com/rhj/assets'
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'

interface RobinhoodAssetsPayload {
  assets: unknown[]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? CACHE_CONTROL : 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

export const onRequest: PagesFunction = async ({ request }) => {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET', 'cache-control': 'no-store' },
    })
  }

  let response: Response
  try {
    response = await fetch(UPSTREAM, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return json({ error: 'Robinhood asset registry unavailable' }, 502)
  }

  if (!response.ok) {
    return json({ error: 'Robinhood asset registry unavailable' }, 502)
  }

  try {
    const payload = (await response.json()) as Partial<RobinhoodAssetsPayload>
    if (!Array.isArray(payload.assets)) throw new Error('invalid payload')
    return json({ assets: payload.assets })
  } catch {
    return json({ error: 'Invalid Robinhood asset registry response' }, 502)
  }
}
