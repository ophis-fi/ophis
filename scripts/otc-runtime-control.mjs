#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BUCKET = 'ophis-otc-control';
const OBJECT = `${BUCKET}/ethereum-mainnet.json`;

function controlValue(mode, expiry, now = Date.now()) {
  if (!['init', 'off', 'on'].includes(mode)) throw new Error('Expected init, off or on');
  if (mode !== 'on') return { enabled: false, expiresAt: 0 };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiry ?? ''))
    throw new Error('UTC expiry required');
  const expiresAt = Date.parse(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 86_400_000)
    throw new Error('Expiry must be in the next 24 hours');
  return { enabled: true, expiresAt };
}

async function api(path, token, method = 'GET', body) {
  if (!token) throw new Error('Cloudflare credential unavailable');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('Cloudflare account unavailable');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (method === 'GET' && response.status === 404) return null;
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new Error(`Cloudflare ${method} ${path} failed (${response.status})`);
  return result.result;
}

async function initialize() {
  const r2Token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!(await api(`r2/buckets/${BUCKET}`, r2Token)))
    await api('r2/buckets', r2Token, 'POST', { name: BUCKET });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const project = await api('pages/projects/greg', token);
  if (!project?.deployment_configs?.production)
    throw new Error('Production Pages configuration unavailable');
  const bindings = project.deployment_configs.production.r2_buckets ?? {};
  if (bindings.OPHIS_OTC_CONTROL && bindings.OPHIS_OTC_CONTROL.name !== BUCKET)
    throw new Error('Existing OTC binding points to another bucket');
  await api('pages/projects/greg', token, 'PATCH', {
    deployment_configs: {
      production: { r2_buckets: { ...bindings, OPHIS_OTC_CONTROL: { name: BUCKET } } },
    },
  });
}

function writeControl(value) {
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!token) throw new Error('Cloudflare R2 credential unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'ophis-otc-control-'));
  try {
    const file = join(directory, 'control.json');
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const result = spawnSync(
      'npx',
      [
        '--yes',
        'wrangler@4.100.0',
        'r2',
        'object',
        'put',
        OBJECT,
        '--remote',
        '--file',
        file,
        '--content-type',
        'application/json',
      ],
      {
        env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
        stdio: 'inherit',
        timeout: 90_000,
      },
    );
    if (result.error || result.status !== 0) throw new Error('Could not write OTC runtime control');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyControl(enabled) {
  const nonce = randomBytes(16).toString('hex');
  const response = await fetch(`https://swap.ophis.fi/api/otc-control?nonce=${nonce}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.nonce, nonce);
  assert.equal(result.enabled, enabled);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
}

if (process.argv[2] === '--self-test') {
  const now = Date.parse('2026-09-08T00:00:00Z');
  assert.deepEqual(controlValue('off'), { enabled: false, expiresAt: 0 });
  assert.deepEqual(controlValue('init'), { enabled: false, expiresAt: 0 });
  assert.equal(controlValue('on', '2026-09-08T01:00:00Z', now).enabled, true);
  for (const expiry of [undefined, '', 'tomorrow', '2026-09-08T00:00:00Z', '2026-09-10T00:00:00Z'])
    assert.throws(() => controlValue('on', expiry, now));
  assert.throws(() => controlValue('invalid'));
  console.log('OTC runtime control checks passed');
} else {
  const mode = process.argv[2];
  const value = controlValue(mode, process.env.OTC_ENABLED_UNTIL);
  if (mode === 'init') await initialize();
  writeControl(value);
  try {
    if (mode !== 'init') await verifyControl(value.enabled);
  } catch (error) {
    if (value.enabled) writeControl({ enabled: false, expiresAt: 0 });
    throw error;
  }
  console.log(`OTC runtime control: ${mode}; expiry: ${value.expiresAt}`);
}
