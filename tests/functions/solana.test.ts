import assert from 'node:assert/strict'
import test from 'node:test'
import { onRequest } from '../../functions/solana-api/[[path]].ts'

type Context = Parameters<typeof onRequest>[0]
const url = 'https://swap.ophis.fi/solana-api/api/v1/quote'
const call = (request: Request) => onRequest({ request, env: {} } as Context)

test('cross-origin, unsupported method and alternate-host requests stay at the edge', async () => {
  assert.equal((await call(new Request(url, { headers: { origin: 'https://example.com' } }))).status, 403)
  assert.equal((await call(new Request(url, { method: 'DELETE' }))).status, 405)
  assert.equal((await call(new Request(url.replace('swap.ophis.fi', 'example.com')))).status, 404)
})

test('forwards the body to the fixed origin and keeps browser credentials and upstream cookies private', async (t) => {
  const body = '{"sellAmount":"1000000"}'
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://solana-mainnet.ophis.fi/solana-api/api/v1/quote')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('cf-access-client-secret'), null)
    assert.equal(new Headers(init.headers).get('cookie'), null)
    assert.equal(new Headers(init.headers).get('authorization'), null)
    assert.equal(await new Response(init.body).text(), body)
    return Response.json({ ok: true }, { headers: { 'set-cookie': 'upstream=x' } })
  })
  const res = await call(new Request(url, { method: 'POST', body, headers: {
    'cf-access-client-secret': 'untrusted', cookie: 'browser=x', authorization: 'Bearer unrelated',
  } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.equal(res.headers.get('set-cookie'), null)
  assert.equal(fetch.mock.callCount(), 1)
})

test('only JSON responses are served on the wallet origin', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unexpected document', {
    headers: { 'content-type': 'text/html' },
  }))
  const res = await call(new Request(url))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(await res.json(), { errorType: 'SettlementPaused' })
})
