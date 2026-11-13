import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { onRequest } from '../../functions/api/relay/[action].ts';

const KEY = 'test-server-secret';
const SAFE = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
const ADDRESS = `0x${'11'.repeat(20)}`;
const ID = `0x${'22'.repeat(32)}`;
const body = () => ({ user: ADDRESS, recipient: ADDRESS, refundTo: ADDRESS, originChainId: 8453, destinationChainId: 10,
  originCurrency: ADDRESS, destinationCurrency: ADDRESS, amount: '10000000', slippageBps: 10 });
const env = (success = true): Context['env'] => ({ RELAY_API_KEY: KEY, OPHIS_RELAY_RATE_LIMITER: {
  idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ success }) }),
} } as unknown as Context['env']);
type Context = Parameters<typeof onRequest>[0];
function call(action = 'quote', data: unknown = body(), bindings: Context['env'] = env(), origin = 'https://swap.ophis.fi'): Promise<Response> {
  const request = new Request(`https://swap.ophis.fi/api/relay/${action}`, { method: 'POST',
    headers: { origin }, body: JSON.stringify(data) });
  return onRequest({ request, env: bindings, params: { action } } as unknown as Context);
}
async function withFetch(run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>, response: unknown = {
  requestId: ID, protocol: {}, details: { currencyOut: {}, timeEstimate: 10, expandedPriceImpact: { app: { usd: '-0.003' } } },
}): Promise<void> {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(response);
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test('only server credentials reach Relay; browser cannot override fee or request swaps', async () => {
  await withFetch(async (calls) => {
    const response = await call('quote', { ...body(), appFees: [{ recipient: ADDRESS, fee: '9999' }], txs: [{}], usePermit: true, explicitDeposit: false });
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, 'https://api.relay.link/quote/v2');
    assert.equal(new Headers(calls[0].init?.headers).get('x-api-key'), KEY);
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(sent.appFees, [{ recipient: SAFE, fee: '3' }]);
    assert.equal(sent.disableOriginSwaps, true);
    assert.equal(sent.explicitDeposit, true);
    assert.equal(sent.includeProtocolData, true);
    assert.equal(sent.usePermit, false);
    assert.equal(sent.txs, undefined);
    assert.equal(sent.refundTo, ADDRESS);
    assert.equal((await response.text()).includes(KEY), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('fee recipient stays pinned to all three Ophis fee sources', () => {
  for (const file of ['packages/sdk/src/partner-fee.ts', 'apps/frontend/libs/common-const/src/feeRecipient.ts',
    'apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts']) assert.ok(readFileSync(file, 'utf8').includes(SAFE));
});

test('rejects invalid money, addresses, chains and slippage before calling Relay', async () => {
  await withFetch(async (calls) => {
    for (const value of [null, [], { ...body(), amount: '0' }, { ...body(), amount: '-1' }, { ...body(), amount: String(2n ** 256n) },
      { ...body(), user: '0x' }, { ...body(), destinationChainId: 123456 }, { ...body(), slippageBps: 101 },
      { ...body(), destinationChainId: 8453 }]) assert.equal((await call('quote', value)).status, 400);
    assert.equal(calls.length, 0);
  });
});

test('fails closed without secret or rate limiter, and does not forward unauthorized routes', async () => {
  await withFetch(async (calls) => {
    assert.equal((await call('quote', body(), {})).status, 503);
    assert.equal((await call('quote', body(), { RELAY_API_KEY: KEY })).status, 503);
    assert.equal((await call('quote', body(), env(), 'https://attacker.example')).status, 403);
    for (const action of ['claim', 'execute', '../metrics/usage', 'access-token']) assert.equal((await call(action)).status, 404);
    assert.equal(calls.length, 0);
  });
});

test('rate limited quotes never reach upstream', async () => {
  await withFetch(async (calls) => {
    assert.equal((await call('quote', body(), env(false))).status, 429);
    assert.equal(calls.length, 0);
  });
});

test('status reads use the shared App budget after per-IP admission', async () => {
  await withFetch(async (calls) => {
    const admissions: { name: string; path: string }[] = [];
    const bindings = { RELAY_API_KEY: KEY, OPHIS_RELAY_RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ fetch: async (url: string) => {
        admissions.push({ name, path: new URL(url).pathname });
        return Response.json({ success: name !== 'relay:app:reads' });
      } }),
    } } as unknown as Context['env'];
    const response = await onRequest({ request: new Request(`https://swap.ophis.fi/api/relay/status?requestId=${ID}`,
      { headers: { 'cf-connecting-ip': '192.0.2.1' } }), env: bindings, params: { action: 'status' } } as unknown as Context);
    assert.equal(response.status, 429);
    assert.deepEqual(admissions, [{ name: 'relay:status:192.0.2.1', path: '/' }, { name: 'relay:app:reads', path: '/reads' }]);
    assert.equal(calls.length, 0);
  });
});

test('chain discovery coalesces before read admission, shares the status budget and retries after rejection', async () => {
  await withFetch(async (calls) => {
    const previous = Date.now;
    const clock = { now: previous(), allowed: true, reads: 0 };
    const admission = Promise.withResolvers<Response>();
    const bindings = { RELAY_API_KEY: KEY, OPHIS_RELAY_RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ fetch: async (url: string) => {
        if (name !== 'relay:app:reads') {
          assert.equal(new URL(url).pathname, '/');
          return Response.json({ success: true });
        }
        assert.equal(new URL(url).pathname, '/reads');
        clock.reads++;
        return clock.allowed ? (await admission.promise).clone() : Response.json({ success: false });
      } }),
    } } as unknown as Context['env'];
    const read = (action: string) => onRequest({ request: new Request(`https://swap.ophis.fi/api/relay/${action}`),
      env: bindings, params: { action: action.split('?')[0] } } as unknown as Context);
    Date.now = () => clock.now;
    try {
      const pending = Promise.all(Array.from({ length: 20 }, () => read('chains')));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(clock.reads, 1);
      assert.equal(calls.length, 0);
      admission.resolve(Response.json({ success: true }));
      assert.ok((await pending).every((response) => response.status === 200));
      assert.equal((await read('chains')).status, 200);
      assert.equal(clock.reads, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.relay.link/chains');
      clock.allowed = false;
      assert.equal((await read(`status?requestId=${ID}`)).status, 429);
      assert.equal(clock.reads, 2);
      assert.equal((await read('chains')).status, 200);
      assert.equal(clock.reads, 2);
      clock.now += 300_001;
      assert.equal((await read('chains')).status, 429);
      assert.equal((await read('chains')).status, 429);
      assert.equal(clock.reads, 4);
      assert.equal(calls.length, 1);
    } finally { Date.now = previous; }
  }, { chains: [] });
});

test('rejects a quote where Relay silently omitted the requested app fee', async () => {
  await withFetch(async () => { assert.equal((await call()).status, 502); }, { details: { expandedPriceImpact: { app: { usd: '0' } } } });
});

test('upstream failures expose a generic error and never expose the server key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(KEY); };
  try {
    const response = await call();
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes(KEY), false);
  } finally { globalThis.fetch = original; }
});

test('status proxy only accepts fixed request ids and strips raw upstream errors', async () => {
  await withFetch(async (calls) => {
    const status = (id: string) => onRequest({ request: new Request(`https://swap.ophis.fi/api/relay/status?requestId=${id}`), env: env(), params: { action: 'status' } } as unknown as Context);
    assert.equal((await status('https://attacker.example')).status, 400);
    const response = await status(ID);
    assert.equal(calls[0].url, `https://api.relay.link/intents/status/v3?requestId=${ID}`);
    assert.deepEqual(await response.json(), { status: 'failure', refundFailReason: 'MANUAL_REFUND_REQUIRED' });
  }, { status: 'failure', refundFailReason: 'MANUAL_REFUND_REQUIRED', revertReason: 'https://phishing.example' });
});
