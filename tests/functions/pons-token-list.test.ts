import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVerifiedLaunchResult,
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
      if (String(input).includes('arrowrpc')) {
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
      if (!String(input).includes('rpc.mainnet.chain.robinhood.com')) {
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

test('mirror agreement cannot override a slower authoritative response', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const requests = JSON.parse(String(init?.body)) as { id: number }[];
      if (String(input).includes('rpc.mainnet.chain.robinhood.com')) {
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
