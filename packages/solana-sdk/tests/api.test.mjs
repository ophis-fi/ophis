import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchOphisSolanaOrder,
  fetchOphisSolanaQuote,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
} from '../dist/index.js';
import fixture from './api-fixture.json' with { type: 'json' };
const input = {
  from: fixture.quote.from,
  sellToken: fixture.quote.quote.sellToken,
  buyToken: fixture.quote.quote.buyToken,
  side: { kind: 'sell', sellAmountBeforeFee: 500_000n },
};

test('queries the explicit native host once, retaining exact amounts and cost units', async (t) => {
  const calls = [];
  const amount = 9_007_199_254_740_993n;
  const value = structuredClone(fixture.quote);
  value.quote.sellAmount = String(amount - BigInt(value.quote.feeAmount));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([String(url), JSON.parse(options.body)]);
    return Response.json(value);
  });
  const quote = await fetchOphisSolanaQuote('https://native.ophis.example/solana', {
    ...input,
    side: { kind: 'sell', sellAmountBeforeFee: amount },
  });
  assert.equal(quote.verified, true);
  assert.equal(quote.from, input.from);
  assert.equal(quote.quote.costs.token, input.buyToken);
  assert.equal(quote.quote.sellAmount, value.quote.sellAmount);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://native.ophis.example/solana/api/v1/quote');
  assert.equal(calls[0][1].sellAmountBeforeFee, '9007199254740993');
  assert.equal(calls[0][1].priceQuality, 'verified');
});

test('requires exact requested sell or buy amounts before accepting a quote', async (t) => {
  const value = structuredClone(fixture.quote);
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  const sell = () => fetchOphisSolanaQuote('https://native.ophis.example', input);
  value.quote.sellAmount = String(BigInt(value.quote.sellAmount) + 1n);
  await assert.rejects(sell(), /sell amount/);
  value.quote.kind = 'buy';
  value.quote.costs.token = input.sellToken;
  const buy = (amount) =>
    fetchOphisSolanaQuote('https://native.ophis.example', {
      ...input,
      side: { kind: 'buy', buyAmountAfterFee: amount },
    });
  await buy(BigInt(value.quote.buyAmount));
  await assert.rejects(buy(BigInt(value.quote.buyAmount) + 1n), /buy amount/);
});

test('verified fee terms require a stored reference and the published share and caps', async (t) => {
  const value = structuredClone(fixture.quote);
  value.quote.feeTerms = { baseBps: 5, improvementShareBps: 5000, improvementCapBps: 99 };
  value.quote.appData = '0x' + 'ab'.repeat(32);
  value.id = 7;
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  const fetchQuote = () => fetchOphisSolanaQuote('https://native.ophis.example', input);
  assert.deepEqual((await fetchQuote()).quote.feeTerms, value.quote.feeTerms);
  value.quote.feeTerms.improvementShareBps = 8000;
  await assert.rejects(fetchQuote(), /fee terms/);
  value.quote.feeTerms.improvementShareBps = 5000;
  value.quote.appData = '0x' + '00'.repeat(32);
  await assert.rejects(fetchQuote(), /fee terms/);
});

test('invalid native response fields cannot silently become a verified quote', async (t) => {
  for (const alter of [
    (value) => {
      value.quote.partiallyFillable = true;
    },
    (value) => {
      value.quote.validTo = Math.floor(Date.now() / 1000) + 3600;
    },
    (value) => {
      delete value.verified;
    },
    (value) => {
      value.verified = 'true';
    },
    (value) => {
      value.quote.buyAmount = 123;
    },
    (value) => {
      value.quote.buyAmount = '18446744073709551616';
    },
    (value) => {
      value.quote.sellToken = input.from;
    },
    (value) => {
      value.quote.kind = 'buy';
    },
    (value) => {
      value.from = input.sellToken;
    },
    (value) => {
      value.quote.costs.token = input.sellToken;
    },
    (value) => {
      value.id = 9_007_199_254_740_993;
    },
  ]) {
    const value = structuredClone(fixture.quote);
    alter(value);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(value)));
    await assert.rejects(fetchOphisSolanaQuote('https://native.ophis.example', input));
  }
});

test('does not retry a rate limit or send invalid input to the backend', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(fetchOphisSolanaQuote('https://native.ophis.example', input), /HTTP 429/);
  assert.equal(fetch.mock.callCount(), 1);
  for (const change of [
    { from: input.from.toLowerCase() },
    { side: { kind: 'sell', sellAmountBeforeFee: 0n } },
    { validFor: -1 },
    { priceQuality: 'other' },
  ])
    await assert.rejects(
      fetchOphisSolanaQuote('https://native.ophis.example', { ...input, ...change }),
    );
  await assert.rejects(fetchOphisSolanaQuote('https://user:secret@native.ophis.example', input));
  assert.equal(fetch.mock.callCount(), 1);
});

test('looks up the native UID and preserves its fulfilled state and exact fills', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(fixture.order)),
  );
  const order = await fetchOphisSolanaOrder('https://native.ophis.example', fixture.order.uid);
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.creationDate, fixture.order.creationDate);
  assert.equal(order.executedSellAmount, fixture.order.executedSellAmount);
  assert.equal(order.owner, fixture.order.owner);
  await assert.rejects(fetchOphisSolanaOrder('https://native.ophis.example', '../../other'));
  assert.equal(fetch.mock.callCount(), 1);
});

test('native SOL quotes request the wrapped route with native wallet funding', async (t) => {
  const value = structuredClone(fixture.quote);
  value.quote.sellToken = WRAPPED_SOL_MINT;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.sellToken, WRAPPED_SOL_MINT);
    assert.equal(body.sellFromNativeSol, true);
    assert.equal(body.walletCreatesBuyTokenAccount, true);
    return new Response(JSON.stringify(value));
  });
  const quote = await fetchOphisSolanaQuote('https://native.ophis.example', {
    ...input,
    sellToken: SOLANA_NATIVE_ASSET,
    walletCreatesBuyTokenAccount: true,
  });
  assert.equal(quote.quote.sellToken, WRAPPED_SOL_MINT);
});

test('owner history preserves unknown and exact settled fees and rejects a mismatched mint', async (t) => {
  const { fetchOphisSolanaTrades } = await import('../dist/index.js');
  const {
    from: owner,
    quote: { sellToken, buyToken },
  } = fixture.quote;
  const row = {
    owner,
    sellToken,
    buyToken,
    orderUid: '0x' + 'ab'.repeat(32),
    sellAmount: '100',
    buyAmount: '200',
    txSignature: '1'.repeat(64),
    instructionIndex: 1,
    slot: 474204967,
  };
  const fee = { protocolFee: '9007199254740993', feeMint: buyToken };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url.searchParams.get('owner'), owner);
    return Response.json([row, { ...row, ...fee }]);
  });
  const history = await fetchOphisSolanaTrades('http://localhost', owner);
  assert.deepEqual(
    history.map((v) => v.protocolFee),
    [null, '9007199254740993'],
  );
  assert.equal(history[0].slot, row.slot);
  fee.feeMint = SOLANA_NATIVE_ASSET;
  assert.equal((await fetchOphisSolanaTrades('http://localhost', owner))[1].feeMint, SOLANA_NATIVE_ASSET);
  fee.feeMint = owner;
  await assert.rejects(fetchOphisSolanaTrades('http://localhost', owner));
});
