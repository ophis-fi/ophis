import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVerifiedLaunchResult,
  parsePonsCatalog,
  ponsTokenListFromResponse,
  rpcResultsById,
} from '../../functions/api/pons-token-list.ts';

const FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571';

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
  const addressWord = (address: string): string => address.slice(2).toLowerCase().padStart(64, '0');
  const uintWord = (value: bigint): string => value.toString(16).padStart(64, '0');
  const words = [
    addressWord(TOKEN),
    addressWord(`0x${'b'.repeat(40)}`),
    addressWord(WETH),
    addressWord(`0x${'c'.repeat(40)}`),
    ...Array.from({ length: 7 }, () => uintWord(0n)),
    uintWord(1n),
    uintWord(0n),
  ];
  const result = `0x${words.join('')}`;

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
