#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function controlValue(mode, expiry, now = Date.now()) {
  if (!['init', 'off', 'on', 'public'].includes(mode))
    throw new Error('Expected init, off, on or public');
  if (mode === 'public') {
    if (expiry) throw new Error('Public control does not accept a trial expiry');
    return { enabled: true, mode: 'public', expiresAt: null };
  }
  if (mode !== 'on') return { enabled: false, expiresAt: 0 };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiry ?? ''))
    throw new Error('UTC expiry required');
  const expiresAt = Date.parse(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 86_400_000)
    throw new Error('Expiry must be in the next 24 hours');
  return { enabled: true, expiresAt };
}

async function initialize() {
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!token) throw new Error('Cloudflare Workers credential unavailable');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/greg/domains/swap.ophis.fi`,
    {
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const domain = await response.json();
  if (!response.ok || !domain.success || !/^[a-f0-9]{32}$/.test(domain.result?.zone_tag ?? ''))
    throw new Error('Pages domain zone unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'ophis-otc-control-'));
  try {
    const config = JSON.parse(readFileSync('apps/otc-control/wrangler.json', 'utf8'));
    config.main = resolve('apps/otc-control/worker.ts');
    config.routes = [
      { pattern: 'swap.ophis.fi/api/otc-control*', zone_id: domain.result.zone_tag },
    ];
    const configFile = join(directory, 'wrangler.json');
    writeFileSync(configFile, JSON.stringify(config));
    const file = join(directory, 'secrets.json');
    writeFileSync(file, JSON.stringify({ OTC_CONTROL_TOKEN: controlToken() }), { mode: 0o600 });
    const result = spawnSync(
      'npx',
      ['--yes', 'wrangler@4.100.0', 'deploy', '--config', configFile, '--secrets-file', file],
      {
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: token,
          npm_config_offline: 'true',
          npm_config_ignore_scripts: 'true',
        },
        stdio: 'inherit',
        timeout: 120_000,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error('Could not deploy OTC runtime control');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function controlToken() {
  const token = process.env.OTC_CONTROL_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('OTC control credential unavailable');
  return token;
}

async function writeControl(value) {
  const nonce = randomBytes(16).toString('hex');
  const response = await fetch(`https://swap.ophis.fi/api/otc-control?nonce=${nonce}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Could not write OTC runtime control (${response.status})`);
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
  assert.equal(
    JSON.parse(readFileSync('apps/otc-control/wrangler.json', 'utf8')).name,
    'ophis-otc-control',
  );
  const now = Date.parse('2026-09-08T00:00:00Z');
  assert.deepEqual(controlValue('off'), { enabled: false, expiresAt: 0 });
  assert.deepEqual(controlValue('init'), { enabled: false, expiresAt: 0 });
  assert.deepEqual(controlValue('public'), { enabled: true, mode: 'public', expiresAt: null });
  assert.throws(() => controlValue('public', '2026-09-08T01:00:00Z'));
  assert.equal(controlValue('on', '2026-09-08T01:00:00Z', now).enabled, true);
  for (const expiry of [undefined, '', 'tomorrow', '2026-09-08T00:00:00Z', '2026-09-10T00:00:00Z'])
    assert.throws(() => controlValue('on', expiry, now));
  assert.throws(() => controlValue('invalid'));
  console.log('OTC runtime control checks passed');
} else {
  const mode = process.argv[2];
  const value = controlValue(mode, process.env.OTC_ENABLED_UNTIL);
  if (mode === 'init') await initialize();
  try {
    await writeControl(value);
    await verifyControl(value.enabled);
  } catch (error) {
    if (value.enabled) await writeControl({ enabled: false, expiresAt: 0 });
    throw error;
  }
  console.log(`OTC runtime control: ${mode}; expiry: ${value.expiresAt}`);
}
