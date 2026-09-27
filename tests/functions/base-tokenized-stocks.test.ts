import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildAssetBatch,
  decodeStockAssets,
  formatWad,
  onRequest,
  parseStockList,
  readLimitedBody,
  rpcResultsById,
  type JsonRpcRequest,
} from '../../functions/api/base/tokenized-stocks.ts';

test('readLimitedBody caps how much of a remote RPC body is buffered before parsing', async () => {
  assert.equal(await readLimitedBody(new Response('{"ok":true}'), 1_000), '{"ok":true}');
  assert.equal(await readLimitedBody(new Response(null), 1_000), '');
  await assert.rejects(() => readLimitedBody(new Response('x'.repeat(2_001)), 2_000), /too large/i);
  assert.equal(await readLimitedBody(new Response('x'.repeat(2_000)), 2_000), 'x'.repeat(2_000));
});

const LIST_PATH =
  'apps/frontend/apps/cowswap-frontend/public/token-lists/coinbase-tokenized-stocks.json';
const AAPLC = '0xb200000000000000000000C2e324d24d7eEcd1fb';
const NVDAC = '0xb20000000000000000000078ee7ce2fE4908108C';
const WAD = 10n ** 18n;

const uintWord = (value: bigint): string => value.toString(16).padStart(64, '0');
const uintResult = (value: bigint): string => `0x${uintWord(value)}`;
// abi-encoded dynamic `uint8[]`: offset word, length word, then one word per element
const enumArrayResult = (values: bigint[]): string =>
  `0x${[uintWord(32n), uintWord(BigInt(values.length)), ...values.map(uintWord)].join('')}`;

const list = (tokens: unknown[]) => ({
  name: 'Coinbase Tokenized Stocks',
  timestamp: '2026-08-24T00:00:00.000Z',
  version: { major: 1, minor: 0, patch: 0 },
  tokens,
});
const token = (overrides: Record<string, unknown> = {}) => ({
  chainId: 8453,
  address: AAPLC,
  name: 'Apple Inc.',
  symbol: 'AAPLc',
  decimals: 8,
  ...overrides,
});

test('the shipped Coinbase list carries all 13 documented B20 stocks with on-chain metadata', () => {
  const shipped = JSON.parse(readFileSync(LIST_PATH, 'utf8'));
  const entries = parseStockList(shipped);

  assert.equal(entries.length, 13);
  assert.equal(new Set(entries.map((entry) => entry.address.toLowerCase())).size, 13);
  assert.ok(entries.some((entry) => entry.address === AAPLC && entry.symbol === 'AAPLc'));
  assert.ok(entries.some((entry) => entry.address === NVDAC && entry.symbol === 'NVDAc'));
  // SPCXc is SpaceX ("Space Exploration Technologies Corp."), not an S&P 500 product.
  assert.ok(
    entries.some((entry) => entry.symbol === 'SPCXc' && /Space Exploration/.test(entry.name)),
  );

  for (const shippedToken of shipped.tokens) {
    assert.equal(shippedToken.chainId, 8453);
    assert.equal(shippedToken.decimals, 8);
    assert.match(shippedToken.symbol, /^[A-Z]+c$/);
    // Logos come from each token's on-chain contractURI; SPCXc has not published one yet.
    if (shippedToken.symbol !== 'SPCXc') {
      assert.match(
        shippedToken.logoURI,
        /^https:\/\/metadata\.coinbase\.com\/equity_icons\/[0-9a-f]{64}\.png$/,
      );
    }
    assert.deepEqual(shippedToken.tags, ['coinbase']);
  }
  assert.equal(typeof shipped.tags?.coinbase?.name, 'string');
});

test('parseStockList keeps only well-formed Base entries and fails closed on a malformed list', () => {
  const entries = parseStockList(
    list([token(), token({ address: NVDAC, symbol: 'NVDAc', name: 'NVIDIA Corporation' })]),
  );
  assert.deepEqual(entries, [
    { address: AAPLC, symbol: 'AAPLc', name: 'Apple Inc.' },
    { address: NVDAC, symbol: 'NVDAc', name: 'NVIDIA Corporation' },
  ]);

  assert.throws(() => parseStockList(list([token({ chainId: 1 })])), /chain/i);
  assert.throws(
    () => parseStockList(list([token({ address: 'javascript:alert(1)' })])),
    /address/i,
  );
  assert.throws(() => parseStockList(list([token({ symbol: '<b>AAPLc</b>' })])), /symbol/i);
  assert.throws(() => parseStockList(list([token(), token()])), /duplicate/i);
  assert.throws(() => parseStockList(list([])), /empty/i);
  assert.throws(() => parseStockList({ tokens: 'nope' }), /malformed/i);
  assert.throws(() => parseStockList(null), /malformed/i);
});

test('buildAssetBatch asks each token for multiplier, pausedFeatures and totalSupply with stable ids', () => {
  const batch = buildAssetBatch([
    { address: AAPLC, symbol: 'AAPLc', name: 'Apple Inc.' },
    { address: NVDAC, symbol: 'NVDAc', name: 'NVIDIA Corporation' },
  ]);

  assert.equal(batch.length, 6);
  assert.deepEqual(
    batch.map((request) => request.id),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(batch[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: AAPLC, data: '0x1b3ed722' }, 'latest'],
  });
  assert.equal(batch[1].params[0].data, '0xde9997e3');
  assert.equal(batch[2].params[0].data, '0x18160ddd');
  assert.equal(batch[3].params[0].to, NVDAC);
});

test('formatWad renders an 18-decimal fixed-point word as a decimal string', () => {
  assert.equal(formatWad(uintResult(WAD)), '1.000000000000000000');
  assert.equal(formatWad(uintResult(WAD + WAD / 50n)), '1.020000000000000000');
  assert.equal(formatWad(uintResult(10n * WAD)), '10.000000000000000000');
  assert.equal(formatWad(uintResult(0n)), '0.000000000000000000');
});

test('decodeStockAssets projects on-chain words into the asset payload', () => {
  const entries = [
    { address: AAPLC, symbol: 'AAPLc', name: 'Apple Inc.' },
    { address: NVDAC, symbol: 'NVDAc', name: 'NVIDIA Corporation' },
  ];
  const results = new Map<number, unknown>([
    [1, uintResult(WAD + WAD / 50n)],
    [2, enumArrayResult([])],
    [3, uintResult(347_772_990_000n)],
    [4, uintResult(WAD)],
    [5, enumArrayResult([1n, 0n])], // MINT + TRANSFER paused
    [6, uintResult(0n)],
  ]);

  assert.deepEqual(decodeStockAssets(entries, results), [
    {
      address: AAPLC,
      symbol: 'AAPLc',
      name: 'Apple Inc.',
      multiplier: '1.020000000000000000',
      issued: true,
      transfersPaused: false,
    },
    {
      address: NVDAC,
      symbol: 'NVDAc',
      name: 'NVIDIA Corporation',
      multiplier: '1.000000000000000000',
      issued: false,
      transfersPaused: true,
    },
  ]);
});

test('decodeStockAssets reports transfersPaused only for the TRANSFER pausable feature', () => {
  const entries = ['A', 'B', 'C', 'D'].map((symbol, index) => ({
    address: `0xb2${index.toString().padStart(38, '0')}`,
    symbol,
    name: symbol,
  }));
  const results = new Map<number, unknown>();
  const pausedByToken = [
    enumArrayResult([1n]), // MINT only -> transfers still open
    enumArrayResult([0n]), // TRANSFER only
    enumArrayResult([2n, 0n]), // BURN + TRANSFER
    enumArrayResult([3n, 2n]), // SEIZE + BURN
  ];
  pausedByToken.forEach((paused, index) => {
    results.set(index * 3 + 1, uintResult(WAD));
    results.set(index * 3 + 2, paused);
    results.set(index * 3 + 3, uintResult(1n));
  });

  assert.deepEqual(
    decodeStockAssets(entries, results).map((asset) => asset.transfersPaused),
    [false, true, true, false],
  );
});

test('the fail-closed decoders bind on every shape check, not just the regex', () => {
  const entries = [{ address: AAPLC, symbol: 'AAPLc', name: 'Apple Inc.' }];
  const good = (): Map<number, unknown> =>
    new Map<number, unknown>([
      [1, uintResult(WAD)],
      [2, enumArrayResult([])],
      [3, uintResult(1n)],
    ]);
  // dynamic-array head with a wrong offset
  assert.throws(
    () =>
      decodeStockAssets(entries, new Map([...good(), [2, `0x${uintWord(64n)}${uintWord(0n)}`]])),
    /array/i,
  );
  // declared length 3 but a single element follows
  assert.throws(
    () =>
      decodeStockAssets(
        entries,
        new Map([...good(), [2, `0x${uintWord(32n)}${uintWord(3n)}${uintWord(0n)}`]]),
      ),
    /array/i,
  );
  // an id the batch never asked for
  assert.throws(
    () =>
      rpcResultsById(
        [
          { id: 1, result: '0x' },
          { id: 2, result: '0x' },
          { id: 3, result: '0x' },
        ],
        [1, 2],
      ),
    /invalid response/i,
  );
  // more tokens than the function is willing to fan out to
  assert.throws(
    () =>
      parseStockList(
        list(
          Array.from({ length: 65 }, (_, i) =>
            token({ address: `0xb2${i.toString().padStart(38, '0')}` }),
          ),
        ),
      ),
    /too large/i,
  );
});

test('decodeStockAssets rejects a zero multiplier or a malformed word instead of shipping it', () => {
  const entries = [{ address: AAPLC, symbol: 'AAPLc', name: 'Apple Inc.' }];
  const good = (): Map<number, unknown> =>
    new Map<number, unknown>([
      [1, uintResult(WAD)],
      [2, enumArrayResult([])],
      [3, uintResult(1n)],
    ]);

  assert.throws(
    () => decodeStockAssets(entries, new Map([...good(), [1, uintResult(0n)]])),
    /multiplier/i,
  );
  assert.throws(() => decodeStockAssets(entries, new Map([...good(), [1, '0x1234']])), /word/i);
  assert.throws(
    () => decodeStockAssets(entries, new Map([...good(), [2, uintResult(0n)]])),
    /array/i,
  );
  assert.throws(() => decodeStockAssets(entries, new Map([...good(), [3, undefined]])), /word/i);
});

test('rpcResultsById fails closed on errors, missing ids, and duplicates', () => {
  const ok = [
    { jsonrpc: '2.0', id: 2, result: '0x01' },
    { jsonrpc: '2.0', id: 1, result: '0x02' },
  ];
  const byId = rpcResultsById(ok, [1, 2]);
  assert.equal(byId.get(1), '0x02');
  assert.equal(byId.get(2), '0x01');

  assert.throws(() =>
    rpcResultsById([{ id: 1, error: { code: 3, message: 'execution reverted' } }], [1]),
  );
  assert.throws(() => rpcResultsById([{ id: 1, result: '0x' }], [1, 2]));
  assert.throws(() => rpcResultsById([...ok, { id: 1, result: '0x03' }], [1, 2]));
  assert.throws(() => rpcResultsById({ id: 1, result: '0x' }, [1]));
});

const shipped = JSON.parse(readFileSync(LIST_PATH, 'utf8'));
const rpcReply = (batch: JsonRpcRequest[], multiplier = WAD) => Response.json(
  batch.map(({ id }) => ({
    jsonrpc: '2.0', id,
    result: id % 3 === 1 ? uintResult(multiplier) :
      id % 3 === 2 ? enumArrayResult([]) : uintResult(1n),
  })).reverse(),
);

async function stockRequest(): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await onRequest({
    request: new Request('https://swap.ophis.fi/api/base/tokenized-stocks'),
    env: { ASSETS: { fetch: async () => Response.json(shipped) } },
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
  } as Parameters<typeof onRequest>[0]);
  await Promise.all(pending);
  return response;
}

test('the handler recovers through three-call dRPC batches with one provider deadline', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const ids: number[] = [];
  const signals = new Set<AbortSignal | null | undefined>();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.includes('publicnode')) return new Response('upstream failure', { status: 403 });
    assert.equal(url, 'https://base.drpc.org');
    const batch: JsonRpcRequest[] = JSON.parse(init.body as string);
    assert.equal(batch.length, 3);
    ids.push(...batch.map(({ id }) => id));
    signals.add(init.signal);
    return rpcReply(batch);
  });
  const response = await stockRequest();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.chainId, 8453);
  assert.equal(payload.assets.length, 13);
  assert.deepEqual(ids, Array.from({ length: 39 }, (_, i) => i + 1));
  assert.equal(signals.size, 1);
  assert.ok([...signals][0] instanceof AbortSignal);
  assert.deepEqual(JSON.parse(warnings.mock.calls[0].arguments[0]), {
    event: 'base-stock-rpc-failed', provider: 'base-rpc.publicnode.com', reason: 'Base RPC returned HTTP 403',
  });
});

test('a failed middle chunk discards that provider snapshot before the ten-call fallback', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const sizes: number[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const batch: JsonRpcRequest[] = JSON.parse(init.body as string);
    if (url.includes('publicnode')) return new Response(null, { status: 503 });
    if (url.includes('drpc')) {
      return batch[0].id === 1 ? rpcReply(batch, 2n * WAD) : Response.json([]);
    }
    assert.equal(url, 'https://mainnet.base.org');
    sizes.push(batch.length);
    assert.ok(batch.length <= 10);
    return rpcReply(batch);
  });
  const response = await stockRequest();
  assert.equal(response.status, 200);
  assert.deepEqual(sizes, [10, 10, 10, 9]);
  const payload = await response.json();
  assert.equal(payload.assets.length, 13);
  assert.ok(payload.assets.every((asset: { multiplier: string }) => asset.multiplier === '1.000000000000000000'));
});

test('all-provider failure stays uncached and logs no upstream body or request details', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('PRIVATE_UPSTREAM_BODY'));
  const response = await stockRequest();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Base RPC unavailable for tokenized stock metadata' });
  assert.equal(warnings.mock.calls.length, 3);
  for (const { arguments: args } of warnings.mock.calls) {
    const log = JSON.parse(args[0]);
    assert.deepEqual(Object.keys(log), ['event', 'provider', 'reason']);
    assert.equal(log.reason, 'Invalid RPC JSON');
    assert.ok(!args[0].includes('PRIVATE_UPSTREAM_BODY'));
  }
});
