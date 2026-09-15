import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../../functions/_middleware.ts';

function request(path: string, response = new Response('Not found', { status: 404 }), host = 'swap.ophis.fi') {
  return onRequest({
    request: new Request(`https://${host}${path}`),
    next: async () => response,
    env: { ASSETS: { fetch: async () => new Response('Business') } },
  } as unknown as Parameters<typeof onRequest>[0]);
}

test('legacy trade and information URLs redirect to their hash route, retaining parameters', async () => {
  for (const path of ['/about', '/legal/', '/profile', '/claim', '/account/tokens', '/otc/12',
    '/4663/swap/USDC/ETH?amount=1&ref=abc', '/swap/hooks/_/_', '/1/widget/limit/ETH/USDC',
    '/1/account-proxy/help', '/1/account-proxy/0x123/recover/0x456']) {
    const res = await request(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('location'), `https://swap.ophis.fi/#${path}`);
  }
});

test('unknown routes retain the native 404 instead of redirecting to the app', async () => {
  for (const path of ['/does-not-exist', '/about/missing', '/1/swap/a/b/extra', '/arbitrary.html']) {
    assert.equal((await request(path)).status, 404, path);
  }
});

test('API responses, existing static pages and app root pass through', async () => {
  for (const path of ['/', '/api/intent', '/ophis-fee-safe-robinhood-ceremony.html']) {
    const res = await request(path, new Response('Existing content'));
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), 'Existing content');
  }
  assert.equal(await (await request('/', undefined, 'business.ophis.fi')).text(), 'Business');
});

test('missing bundles and old HTML fallbacks cannot receive immutable cache headers', async () => {
  for (const status of [200, 404]) {
    const res = await request('/static/missing.js', new Response('<html>Error</html>', {
      status, headers: { 'content-type': 'text/html', 'cache-control': 'public,max-age=31536000,immutable' },
    }));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('docs aliases preserve the path and cannot redirect to another host', async () => {
  for (const path of ['/docs', '/docs/fees', '/docs///example.com']) {
    const res = await request(path);
    assert.equal(res.status, 301);
    assert.equal(new URL(res.headers.get('location') || '').hostname, 'docs.ophis.fi');
  }
  assert.equal((await request('/docs/fees?x=1')).headers.get('location'), 'https://docs.ophis.fi/fees?x=1');
});
