import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost } from '../../functions/api/beat-market.ts';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function quoteRequest(): Request {
  return new Request('https://swap.ophis.fi/api/beat-market', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://swap.ophis.fi' },
    body: JSON.stringify({ chainId: 1, sellToken: USDC, buyToken: WETH, sellAmount: '100000000' }),
  });
}

async function withUpstream(
  status: number,
  body: unknown,
  run: () => Promise<Response>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const call = (): Promise<Response> =>
  // Only request + env are read; the rest of the Pages context is unused here.
  onRequestPost({ request: quoteRequest(), env: {} } as unknown as Parameters<typeof onRequestPost>[0]);

test('relays a reference amountOut on upstream success', async () => {
  const res = await withUpstream(200, { data: { routeSummary: { amountOut: '40440827659578272' } } }, call);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, data: { source: 'kyberswap', amountOut: '40440827659578272' } });
});

test('an upstream 4xx (token not found) is "no reference", not a gateway error', async () => {
  // KyberSwap answers 400 code 4011 for a token it does not know; that used to
  // come back as a 502 and an error line in every bridge session's console.
  const res = await withUpstream(400, { code: 4011, message: 'token not found' }, call);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'UPSTREAM');
});

test('upstream throttling stays visible as a 503 that carries Retry-After', async () => {
  const res = await withUpstream(429, { message: 'slow down' }, call, { 'retry-after': '17' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '17');
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
});

test('an upstream 403 (blocked client) and 5xx are still a 502', async () => {
  assert.equal((await withUpstream(403, { message: 'forbidden' }, call)).status, 502);
  assert.equal((await withUpstream(503, { message: 'down' }, call)).status, 502);
});

test('the upstream request carries a client id (own KyberSwap rate-limit bucket)', async () => {
  const originalFetch = globalThis.fetch;
  let clientId: string | null = null;
  globalThis.fetch = async (_input, init) => {
    clientId = new Headers(init?.headers).get('x-client-id');
    return new Response(JSON.stringify({ data: { routeSummary: { amountOut: '1' } } }), { status: 200 });
  };
  try {
    await call();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(clientId, 'ophis-swap-beat-market');
});
