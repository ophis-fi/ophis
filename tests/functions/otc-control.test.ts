import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { handleControl } from '../../apps/otc-control/handler.ts';

const nonce = 'a'.repeat(32);
const token = 'b'.repeat(64);
const url = `https://swap.ophis.fi/api/otc-control?nonce=${nonce}`;
const active = () => ({ enabled: true, expiresAt: Date.now() + 60_000 });
async function read(value: unknown, request = new Request(url)): Promise<Response> {
  return handleControl(request, { read: async () => value, write: async () => {} }, token);
}

test('permission requires literal true and an expiry within 24 hours, without caching', async () => {
  const response = await read(active());
  assert.deepEqual(await response.json(), { enabled: true, nonce });
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  for (const value of [
    null,
    [],
    {},
    { ...active(), enabled: 'true' },
    { ...active(), enabled: false },
    { enabled: true, expiresAt: Date.now() },
    { enabled: true, expiresAt: Date.now() + 172_800_000 },
    { enabled: true, expiresAt: Infinity },
    { enabled: true, expiresAt: '9999999999999' },
  ]) {
    assert.equal((await (await read(value)).json()).enabled, false);
  }
});

test('authenticated updates persist before responding and subsequent readers observe shutdown', async () => {
  let value: unknown;
  const storage = {
    read: async () => value,
    write: async (next: unknown) => {
      value = next;
    },
  };
  for (const next of [active(), { enabled: false }]) {
    const body = JSON.stringify(next);
    const request = new Request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': String(body.length) },
      body,
    });
    const response = await handleControl(request, storage, token);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, next.enabled);
    const other = 'c'.repeat(32);
    assert.deepEqual(
      await (await handleControl(new Request(url.replace(nonce, other)), storage, token)).json(),
      { enabled: next.enabled, nonce: other },
    );
  }
});

test('bad authentication, oversized bodies and invalid expiry cannot mutate the control', async () => {
  const body = JSON.stringify(active());
  const storage = {
    read: async () => undefined,
    write: async () => assert.fail('unauthorized write'),
  };
  for (const [authorization, payload, size, status] of [
    ['', body, body.length, 403],
    [`Bearer ${'c'.repeat(64)}`, body, body.length, 403],
    [`Bearer ${token}`, body, 1_025, 413],
    [
      `Bearer ${token}`,
      JSON.stringify({ enabled: true, expiresAt: Date.now() + 172_800_000 }),
      100,
      400,
    ],
  ] as const) {
    const request = new Request(url, {
      method: 'POST',
      headers: { authorization, 'content-length': String(size) },
      body: payload,
    });
    assert.equal((await handleControl(request, storage, token)).status, status);
  }
});

test('storage failures, preview origins and malformed requests cannot enable writes', async () => {
  const preview = new Request(url.replace('swap.ophis.fi', 'preview.greg.pages.dev'));
  assert.equal((await read(active(), preview)).status, 404);
  assert.equal((await read(active(), new Request(url, { method: 'DELETE' }))).status, 405);
  assert.equal((await read(active(), new Request(url.replace(nonce, 'invalid')))).status, 400);
  const response = await handleControl(
    new Request(url),
    {
      read: () => Promise.reject(new Error('offline')),
      write: async () => {},
    },
    token,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { enabled: false, nonce });
});

test('a lost enablement response attempts to restore disabled state', () => {
  const mock = `globalThis.fetch = async (_url, options) => {
    const value = JSON.parse(options.body); console.log(value.enabled);
    if (value.enabled) throw new Error('response lost after commit');
    return new Response('{}');
  };`;
  const preload = 'data:text/javascript,' + encodeURIComponent(mock);
  const expiry = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = spawnSync(
    process.execPath,
    ['--import', preload, 'scripts/otc-runtime-control.mjs', 'on'],
    {
      env: { ...process.env, OTC_CONTROL_TOKEN: token, OTC_ENABLED_UNTIL: expiry },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trim().split('\n'), ['true', 'false']);
});
