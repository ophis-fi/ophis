export const onRequest: PagesFunction = async ({ request }) => {
  const target = new URL(request.url)
  if (target.origin !== 'https://swap.ophis.fi') return new Response(null, { status: 404 })
  if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 })
  const origin = request.headers.get('Origin')
  if (origin && origin !== target.origin) return new Response(null, { status: 403 })

  const paused = () => Response.json({ errorType: 'SettlementPaused' }, {
    status: 503, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
  target.hostname = 'solana-mainnet.ophis.fi'
  try {
    const response = await fetch(target.toString(), {
      method: request.method, body: request.body, redirect: 'error',
      headers: { 'content-type': 'application/json' },
    })
    const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (media !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(media ?? '')) return paused()
    return new Response(response.body, { status: response.status, headers: {
      'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff',
    } })
  } catch {
    return paused()
  }
}
