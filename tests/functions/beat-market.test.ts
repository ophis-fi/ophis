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

async function withUpstream(status: number, body: unknown, run: () => Promise<Response>): Promise<Response> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

test('an upstream 5xx is still a 502', async () => {
  const res = await withUpstream(503, { message: 'down' }, call);
  assert.equal(res.status, 502);
});
