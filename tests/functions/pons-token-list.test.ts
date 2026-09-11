import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVerifiedLaunchResult,
  onRequestGet,
  parsePonsCatalog,
  ponsTokenListFromResponse,
  rpcResultsById,
  verifyLaunchesOnchain,
} from '../../functions/api/pons-token-list.ts';

const FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571';

const addressWord = (address: string): string => address.slice(2).toLowerCase().padStart(64, '0');
const uintWord = (value: bigint): string => value.toString(16).padStart(64, '0');

function verifiedResult(): string {
  return `0x${[
    addressWord(TOKEN),
    addressWord(`0x${'b'.repeat(40)}`),
    addressWord(WETH),
    addressWord(`0x${'c'.repeat(40)}`),
    ...Array.from({ length: 7 }, () => uintWord(0n)),
    uintWord(1n),
    uintWord(0n),
  ].join('')}`;
}

const launch = (overrides: Record<string, unknown> = {}) => ({
  factory: FACTORY,
  pairToken: WETH,
  token: TOKEN,
  name: 'Pons',
  symbol: 'PONS',
  logo: 'ipfs://bafybeiehcgbqotmir6tqi76eorpihucphlry53cx3mmnxgmqjjxpwherwq',
  ...overrides,
});

test('adapts active and graduated Pons launches to a token list', () => {
  const now = new Date('2026-08-03T17:00:00.000Z');
  const result = ponsTokenListFromResponse(
    {
      active: { items: [launch()] },
      graduated: { items: [launch({ token: `0x${'a'.repeat(40)}` })] },
    },
    now,
  );

  assert.equal(result.name, 'Pons Recent Launches');
  assert.equal(result.timestamp, now.toISOString());
  assert.equal(result.tokens.length, 2);
  assert.deepEqual(result.tokens[0], {
    chainId: 4663,
    address: TOKEN,
    name: 'Pons',
    symbol: 'PONS',
    decimals: 18,
    logoURI: 'ipfs://bafybeiehcgbqotmir6tqi76eorpihucphlry53cx3mmnxgmqjjxpwherwq',
  });
});

test('filters entries outside the documented Pons factories and WETH pair', () => {
  const result = ponsTokenListFromResponse([
    launch(),
    launch({ factory: `0x${'b'.repeat(40)}`, token: `0x${'c'.repeat(40)}` }),
    launch({ pairToken: `0x${'d'.repeat(40)}`, token: `0x${'e'.repeat(40)}` }),
    launch({ token: 'not-an-address' }),
  ]);
  assert.deepEqual(
    result.tokens.map(({ address }) => address),
    [TOKEN],
  );
});

test('deduplicates addresses and sanitizes untrusted display metadata', () => {
  const result = ponsTokenListFromResponse([
    launch({ name: '<script>Pons</script>', symbol: 'P<ONS', logo: 'javascript:alert(1)' }),
    launch({ token: TOKEN.toLowerCase() }),
  ]);
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0]?.name, 'scriptPons/script');
  assert.equal(result.tokens[0]?.symbol, 'PONS');
  assert.equal(result.tokens[0]?.logoURI, undefined);
});

test('rejects creator-controlled HTTPS logos as tracking beacons', () => {
  const result = ponsTokenListFromResponse([launch({ logo: 'https://example.com/tracker.png' })]);
  assert.equal(result.tokens[0]?.logoURI, undefined);
});

test('accepts only an onchain launch tuple matching token, WETH, and exists', () => {
  const result = verifiedResult();

  assert.equal(isVerifiedLaunchResult(launch(), result), true);
  assert.equal(isVerifiedLaunchResult(launch({ token: `0x${'d'.repeat(40)}` }), result), false);
  assert.equal(
    isVerifiedLaunchResult(
      launch(),
      `${result.slice(0, 2 + 11 * 64)}${uintWord(0n)}${result.slice(2 + 12 * 64)}`,
    ),
    false,
  );
  assert.equal(isVerifiedLaunchResult(launch(), '0xdeadbeef'), false);
});

test('rejects malformed successful Pons catalog envelopes', () => {
  assert.throws(() => parsePonsCatalog({ error: 'soft failure' }), /malformed response/);
  assert.throws(() => parsePonsCatalog({ active: { items: null } }), /malformed response/);
  assert.deepEqual(parsePonsCatalog({ active: { items: [null, 'bad', [], launch()] } }), [
    launch(),
  ]);
});

test('rejects JSON-RPC errors, missing IDs, duplicates, and unexpected IDs', () => {
  assert.throws(
    () => rpcResultsById([{ id: 0, error: { code: -32000 } }], [0]),
    /invalid response/,
  );
  assert.throws(() => rpcResultsById([{ id: 0, result: '0x' }], [0, 1]), /incomplete response/);
  assert.throws(
    () =>
      rpcResultsById(
        [
          { id: 0, result: '0x' },
          { id: 0, result: '0x' },
        ],
        [0],
      ),
    /incomplete response/,
  );
  assert.throws(() => rpcResultsById([{ id: 1, result: '0x' }], [0]), /invalid response/);
  assert.deepEqual([...rpcResultsById([{ id: 0, result: '0x1234' }], [0])], [[0, '0x1234']]);
});

test('RPC quorum obeys an expired outer deadline and fails once quorum is impossible', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('unexpected fetch');
    };
    const expired = new AbortController();
    expired.abort();
    await assert.rejects(verifyLaunchesOnchain([launch()], expired.signal), /quorum unavailable/);
    assert.equal(fetchCalls, 0);

    let minorityAborted = false;
    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      if (new URL(String(input)).hostname === 'robinhood-rpc.publicnode.com') {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              minorityAborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }
      throw new Error('provider unavailable');
    };
    await assert.rejects(
      verifyLaunchesOnchain([launch()], new AbortController().signal),
      /quorum unavailable/,
    );
    assert.equal(minorityAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RPC quorum binds verification to the exact factory-token request', async () => {
  const originalFetch = globalThis.fetch;
  const otherFactory = '0x0c37a24F5D23A486FA692d1500881d698B1F77a4';
  try {
    globalThis.fetch = async (_input, init) => {
      const requests = JSON.parse(String(init?.body)) as { id: number }[];
      return Response.json(
        requests.map(({ id }) => ({
          jsonrpc: '2.0',
          id,
          result: id === 1 ? verifiedResult() : '0xdeadbeef',
        })),
      );
    };

    const verified = await verifyLaunchesOnchain(
      [launch(), launch({ factory: otherFactory })],
      new AbortController().signal,
    );
    assert.equal(verified.length, 1);
    assert.equal(verified[0]?.factory, otherFactory);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fast mirror failures do not abort a pending authoritative verification', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://rpc.mainnet.chain.robinhood.com') {
        throw new Error('mirror unavailable');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      const requests = JSON.parse(String(init?.body)) as { id: number }[];
      return Response.json(
        requests.map(({ id }) => ({ jsonrpc: '2.0', id, result: verifiedResult() })),
      );
    };

    const verified = await verifyLaunchesOnchain([launch()], new AbortController().signal);
    assert.equal(verified.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requires both mirrors when the official RPC is rate limited', async (t) => {
  let publicNodeAvailable = true;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const host = new URL(String(input)).hostname;
    if (host === 'rpc.mainnet.chain.robinhood.com')
      return new Response('Rate limited', { status: 429 });
    if (host === 'robinhood-rpc.publicnode.com' && !publicNodeAvailable)
      throw new Error('Unavailable');
    const requests = JSON.parse(String(init?.body)) as { id: number }[];
    return Response.json(
      requests.map(({ id }) => ({ jsonrpc: '2.0', id, result: verifiedResult() })),
    );
  });
  assert.equal((await verifyLaunchesOnchain([launch()], new AbortController().signal)).length, 1);
  publicNodeAvailable = false;
  await assert.rejects(
    verifyLaunchesOnchain([launch()], new AbortController().signal),
    /quorum unavailable/,
  );
});

test('mirror agreement cannot override a slower authoritative response', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const requests = JSON.parse(String(init?.body)) as { id: number }[];
      if (String(input) === 'https://rpc.mainnet.chain.robinhood.com') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json(
          requests.map(({ id }) => ({ jsonrpc: '2.0', id, result: '0xdeadbeef' })),
        );
      }
      return Response.json(
        requests.map(({ id }) => ({ jsonrpc: '2.0', id, result: verifiedResult() })),
      );
    };

    const verified = await verifyLaunchesOnchain([launch()], new AbortController().signal);
    assert.deepEqual(verified, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps reference PONS discoverable during catalog outages only after onchain verification', async (t) => {
  let verified = true;
  let catalogResponse: Response | undefined;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (new URL(String(input)).hostname === 'www.ponsfamily.com') {
      if (!catalogResponse) throw new Error('Network failure');
      return catalogResponse.clone();
    }
    const requests = JSON.parse(String(init?.body)) as { id: number }[];
    return Response.json(
      requests.map(({ id }) => ({
        jsonrpc: '2.0',
        id,
        result: verified ? verifiedResult() : '0x',
      })),
    );
  });
  const context = {
    request: new Request('https://swap.ophis.fi/api/pons-token-list'),
    waitUntil: (_promise: Promise<unknown>) => undefined,
  } as Parameters<typeof onRequestGet>[0];
  for (catalogResponse of [
    undefined,
    new Response('Unavailable', { status: 503 }),
    new Response('{'),
    Response.json({ error: 'Unavailable' }),
  ]) {
    const available = await onRequestGet(context);
    assert.equal(available.status, 200);
    assert.deepEqual(
      (await available.json()).tokens.map(({ address }) => address),
      [TOKEN],
    );
  }
  verified = false;
  const unavailable = await onRequestGet(context);
  assert.equal(unavailable.status, 503);
});

test('verifies reference PONS after the catalog deadline expires', async (t) => {
  const catalog = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 5_000);
    return catalog.signal;
  });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (new URL(String(input)).hostname === 'www.ponsfamily.com') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Catalog timeout')), {
          once: true,
        });
        queueMicrotask(() => catalog.abort());
      });
    }
    assert.equal(catalog.signal.aborted, true);
    assert.equal(init?.signal?.aborted, false);
    const requests = JSON.parse(String(init?.body)) as { id: number }[];
    return Response.json(
      requests.map(({ id }) => ({ jsonrpc: '2.0', id, result: verifiedResult() })),
    );
  });
  const response = await onRequestGet({
    request: new Request('https://swap.ophis.fi/api/pons-token-list'),
    waitUntil: () => undefined,
  } as Parameters<typeof onRequestGet>[0]);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).tokens.map(({ address }) => address),
    [TOKEN],
  );
});

test('discovers bounded v2 launches and requires their exact on-chain tuple', async (t) => {
  const factory = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
  const token = `0x${'e'.repeat(40)}`;
  const pairToken = `0x${'0'.repeat(40)}`;
  const v2 = launch({ factory, token, pairToken, symbol: 'V2' });
  const tuple = (phase = 0n, exists = 1n): string =>
    `0x${[
      addressWord(token),
      ...Array.from({ length: 3 }, () => uintWord(0n)),
      addressWord(pairToken),
      ...Array.from({ length: 5 }, () => uintWord(0n)),
      uintWord(phase),
      ...Array.from({ length: 3 }, () => uintWord(0n)),
      uintWord(exists),
    ].join('')}`;
  assert.equal(isVerifiedLaunchResult(v2, tuple()), true);
  assert.equal(isVerifiedLaunchResult(v2, tuple(2n)), true);
  for (const result of [tuple(1n), tuple(3n), tuple(0n, 0n), verifiedResult()]) {
    assert.equal(isVerifiedLaunchResult(v2, result), false);
  }
  assert.equal(isVerifiedLaunchResult({ ...v2, token: TOKEN }, tuple()), false);
  assert.equal(isVerifiedLaunchResult({ ...v2, pairToken: WETH }, tuple()), false);
  const catalog = {
    active: { items: Array.from({ length: 100 }, () => v2) },
    graduated: { items: [launch()] },
  };
  const parsed = parsePonsCatalog(catalog);
  assert.equal(parsed.length, 75);
  assert.deepEqual(parsed[0], launch());
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (new URL(String(input)).hostname === 'www.ponsfamily.com') {
      return Response.json({ active: { items: [v2] } });
    }
    const requests = JSON.parse(String(init?.body)) as { id: number; params: { to: string }[] }[];
    return Response.json(
      requests.map(({ id, params }) => ({
        jsonrpc: '2.0',
        id,
        result: params[0]?.to === factory ? tuple() : verifiedResult(),
      })),
    );
  });
  const response = await onRequestGet({
    request: new Request('https://swap.ophis.fi/api/pons-token-list'),
    waitUntil: () => {},
  } as Parameters<typeof onRequestGet>[0]);
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.deepEqual(
    list.tokens.map((entry: { symbol: string }) => entry.symbol),
    ['PONS', 'V2'],
  );
});

test('keeps verified discovery when a later RPC batch is rate limited', async (t) => {
  const launches = Array.from({ length: 21 }, (_, index) =>
    launch({ token: `0x${(index + 1).toString(16).padStart(40, '0')}` }),
  );
  let failFirstBatch = false;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const requests = JSON.parse(String(init?.body)) as { id: number; params: { data: string }[] }[];
    if (
      failFirstBatch ||
      new URL(String(input)).hostname === 'rpc.mainnet.chain.robinhood.com' ||
      requests[0]!.id >= 20
    )
      return new Response('Rate limited', { status: 429 });
    return Response.json(
      requests.map(({ id, params }) => ({
        id,
        result: `0x${params[0]!.data.slice(-64)}${verifiedResult().slice(66)}`,
      })),
    );
  });
  const verified = await verifyLaunchesOnchain(launches, new AbortController().signal);
  assert.deepEqual(verified, launches.slice(0, 20));
  assert.ok(!verified.includes(launches[20]!));
  failFirstBatch = true;
  await assert.rejects(
    verifyLaunchesOnchain(launches, new AbortController().signal),
    /quorum unavailable/,
  );
});
