export const onRequest: PagesFunction = async ({ request }) => {
  const target = new URL(request.url)
  if (target.origin !== 'https://swap.ophis.fi') return new Response(null, { status: 404 })
  if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 })
  const origin = request.headers.get('Origin')
  if (origin && origin !== target.origin) return new Response(null, { status: 403 })

  const paused = () => Response.json({ errorType: 'SettlementPaused' }, {
    status: 503, headers: { 'cache-control': 'no-store' },
  })
  target.hostname = 'solana-mainnet.ophis.fi'
  try {
    const response = await fetch(target.toString(), {
      method: request.method, body: request.body, redirect: 'error',
      headers: { 'content-type': 'application/json' },
    })
    // The tunnel can return HTML while the swap box expects JSON.
    if (response.headers.get('content-type')?.includes('text/html') && response.status >= 500) return paused()
    return new Response(response.body, { status: response.status, headers: {
      'cache-control': 'no-store', 'content-type': response.headers.get('content-type') || 'application/json',
    } })
  } catch {
    return paused()
  }
}
