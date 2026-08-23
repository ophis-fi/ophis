#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9545;
const MAX_BODY_BYTES = 1_000_000;
const MAX_ATTEMPTS = 8;
const DEFAULT_INTERVAL_MS = 750;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

let requestQueue = Promise.resolve();
let lastAttemptStartedAt = 0;

function isTrustedProvider(url) {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (host === 'infura.io' ||
      host.endsWith('.infura.io') ||
      host === 'alchemy.com' ||
      host.endsWith('.alchemy.com'))
  );
}

function providerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OTC fork RPC must be a valid trusted HTTPS provider URL');
  }
  if (!isTrustedProvider(url)) throw new Error('OTC fork RPC must use a trusted HTTPS provider');
  return url;
}

function isReadOnlyMethod(method) {
  return (
    method.startsWith('eth_get') ||
    [
      'eth_blockNumber',
      'eth_call',
      'eth_chainId',
      'eth_estimateGas',
      'eth_feeHistory',
      'eth_gasPrice',
      'eth_maxPriorityFeePerGas',
      'net_version',
      'web3_clientVersion',
    ].includes(method)
  );
}

function isValidRequest(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    item.jsonrpc === '2.0' &&
    typeof item.method === 'string' &&
    isReadOnlyMethod(item.method) &&
    (item.params === undefined || Array.isArray(item.params) || typeof item.params === 'object')
  );
}

function isValidPayload(payload) {
  return Array.isArray(payload)
    ? payload.length > 0 && payload.every(isValidRequest)
    : isValidRequest(payload);
}

function containsRateLimitError(payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.some(
    (item) =>
      item?.error?.code === -32005 ||
      /too many requests|rate limit/i.test(String(item?.error?.message ?? '')),
  );
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSlot(intervalMs) {
  const delay = lastAttemptStartedAt + intervalMs - Date.now();
  if (delay > 0) await sleep(delay);
  lastAttemptStartedAt = Date.now();
}

function serialize(task) {
  const next = requestQueue.then(task, task);
  requestQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('RPC request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function forwardWithRetry(upstream, body, intervalMs) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await waitForSlot(intervalMs);
    try {
      const response = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const responseBody = await response.text();
      let rateLimited = response.status === 429;
      try {
        rateLimited ||= containsRateLimitError(JSON.parse(responseBody));
      } catch {
        // A non-JSON upstream error is handled by its HTTP status.
      }
      if ((!RETRYABLE_STATUS.has(response.status) && !rateLimited) || attempt === MAX_ATTEMPTS) {
        return { status: response.status, body: responseBody };
      }
      const backoffMs = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
      await sleep(Math.max(backoffMs, retryAfterMs(response)));
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      await sleep(Math.min(2_000 * 2 ** (attempt - 1), 30_000));
    }
  }
  throw new Error('RPC retry loop exhausted');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function handleRequest(request, response, upstream, intervalMs) {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/') {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  try {
    const body = await readRequestBody(request);
    const payload = JSON.parse(body);
    if (!isValidPayload(payload))
      throw new Error('Only read-only Ethereum JSON-RPC methods are allowed');
    const result = await serialize(() => forwardWithRetry(upstream, body, intervalMs));
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(result.body);
  } catch {
    sendJson(response, 502, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'RPC proxy request failed' },
    });
  }
}

async function runSelfTest() {
  assert.equal(isTrustedProvider(new URL('https://mainnet.infura.io/v3/example')), true);
  assert.equal(isTrustedProvider(new URL('https://eth-mainnet.g.alchemy.com/v2/example')), true);
  assert.equal(
    isTrustedProvider(new URL('https://mainnet.infura.io.evil.example/v3/example')),
    false,
  );
  assert.equal(
    isValidPayload({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [] }),
    true,
  );
  assert.equal(
    isValidPayload({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [] }),
    false,
  );
  assert.equal(
    containsRateLimitError({ error: { code: -32005, message: 'Too Many Requests' } }),
    true,
  );
  const order = [];
  await Promise.all([
    serialize(async () => {
      await sleep(5);
      order.push('first');
    }),
    serialize(async () => order.push('second')),
  ]);
  assert.deepEqual(order, ['first', 'second']);
  process.stdout.write('OTC serial RPC proxy self-test passed\n');
}

function start() {
  const upstream = providerUrl(process.env.OTC_RPC_UPSTREAM_URL ?? '');
  const configuredInterval = Number(process.env.OTC_RPC_MIN_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(configuredInterval)
    ? Math.max(DEFAULT_INTERVAL_MS, configuredInterval)
    : DEFAULT_INTERVAL_MS;
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, upstream, intervalMs);
  });
  server.listen(PORT, HOST, () =>
    process.stdout.write(`OTC RPC proxy listening on ${HOST}:${PORT}\n`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv.includes('--self-test')) await runSelfTest();
else start();
