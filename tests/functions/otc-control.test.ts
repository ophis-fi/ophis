import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { onRequest } from '../../functions/api/otc-control.ts';

const nonce = 'a'.repeat(32);
const url = `https://swap.ophis.fi/api/otc-control?nonce=${nonce}`;

async function read(value: unknown, request = new Request(url)): Promise<Response> {
  return onRequest({
    request,
    env: {
      OPHIS_OTC_CONTROL: {
        get: async () => ({ size: 100, json: async () => value }),
      },
    },
  } as unknown as Parameters<typeof onRequest>[0]) as Promise<Response>;
}

test('runtime control requires literal enablement and a future expiry, without caching', async () => {
  const response = await read({ enabled: true, expiresAt: Date.now() + 60_000 });
  assert.deepEqual(await response.json(), { enabled: true, nonce });
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  for (const value of [
    null,
    [],
    {},
    { enabled: 'true', expiresAt: Date.now() + 60_000 },
    { enabled: false, expiresAt: Date.now() + 60_000 },
    { enabled: true, expiresAt: Date.now() },
    { enabled: true, expiresAt: Infinity },
    { enabled: true, expiresAt: '9999999999999' },
  ]) {
    assert.equal((await (await read(value)).json()).enabled, false);
  }
});

test('off updates are visible on the next read; each response echoes its own nonce', async () => {
  assert.equal(
    (await (await read({ enabled: true, expiresAt: Date.now() + 60_000 })).json()).enabled,
    true,
  );
  const other = 'b'.repeat(32);
  const response = await read({ enabled: false }, new Request(url.replace(nonce, other)));
  assert.deepEqual(await response.json(), { enabled: false, nonce: other });
});

test('unavailable storage, preview origins and malformed requests cannot enable writes', async () => {
  const value = { enabled: true, expiresAt: Date.now() + 60_000 };
  assert.equal(
    (await read(value, new Request(url.replace('swap.ophis.fi', 'preview.greg.pages.dev')))).status,
    503,
  );
  assert.equal((await read(value, new Request(url, { method: 'POST' }))).status, 405);
  assert.equal((await read(value, new Request(url.replace(nonce, 'invalid')))).status, 400);
  for (const storage of [
    undefined,
    {
      get: async () => {
        throw new Error('offline');
      },
    },
    { get: async () => null },
    { get: async () => ({ size: 1_025 }) },
    {
      get: async () => ({
        size: 10,
        json: async () => {
          throw new Error('invalid JSON');
        },
      }),
    },
  ]) {
    const context = {
      request: new Request(url),
      env: { OPHIS_OTC_CONTROL: storage },
    } as unknown as Parameters<typeof onRequest>[0];
    const response = await onRequest(context);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { enabled: false, nonce });
  }
});

test('a possibly committed enablement with a lost response attempts to restore disabled state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'otc-control-test-'));
  const history = join(directory, 'history.jsonl');
  try {
    writeFileSync(
      join(directory, 'npx'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--file') + 1]));
fs.appendFileSync(process.env.OTC_TEST_HISTORY, JSON.stringify(value) + '\\n');
process.exit(value.enabled ? 1 : 0);
`,
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, ['scripts/otc-runtime-control.mjs', 'on'], {
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        OTC_TEST_HISTORY: history,
        CLOUDFLARE_WORKERS_TOKEN: 'test-only',
        OTC_ENABLED_UNTIL: new Date(Date.now() + 60_000)
          .toISOString()
          .replace('.000Z', 'Z')
          .replace(/\.\d{3}Z$/, 'Z'),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    const writes = readFileSync(history, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      writes.map((value) => value.enabled),
      [true, false],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
