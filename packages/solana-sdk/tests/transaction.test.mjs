import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address, createNoopSigner } from '@solana/kit';
import {
  prepareOphisSolanaOrder,
  prepareOphisSolanaOrderFromQuote,
  compileOphisSolanaWalletTransaction,
  fetchOphisSolanaChainContext,
  checkOphisWalletAction,
  fetchOphisWalletActionContext,
  fetchOphisSolanaMint,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  parseOphisSolanaAmount,
  formatOphisSolanaAmount,
} from '../dist/index.js';
import fixture from './rust-intent-v054.json' with { type: 'json' };
import api from './api-fixture.json' with { type: 'json' };
const owner = createNoopSigner(address(fixture.owner));
const params = {
  programAddress: address(fixture.program),
  owner,
  sellMint: address(fixture.sellMint),
  sellProgram: TOKEN_PROGRAM_ADDRESS,
  buyMint: address(fixture.buyMint),
  buyProgram: TOKEN_PROGRAM_ADDRESS,
  sellAmount: 9007199254740993n,
  buyAmount: 1000000n,
  validTo: 0xffffffff,
  kind: 'sell',
};

test('wallet packets are unsigned v0, bounded and bound to the deployment and full genesis', async () => {
  const order = await prepareOphisSolanaOrder(params);
  const context = {
    programAddress: params.programAddress,
    genesisHash: fixture.owner,
    blockhash: fixture.owner,
    lastValidBlockHeight: 100n,
    contextSlot: 80n,
  };
  const input = {
    instructions: order.instructions,
    payer: owner.address,
    programAddress: params.programAddress,
    expectedGenesisHash: context.genesisHash,
    context,
  };
  const bytes = compileOphisSolanaWalletTransaction(input);
  assert.equal(bytes[0], 1);
  assert.deepEqual(bytes.subarray(1, 65), new Uint8Array(64));
  assert.equal(bytes[65], 0x80);
  assert.ok(bytes.length <= 1232);
  assert.throws(() =>
    compileOphisSolanaWalletTransaction({
      ...input,
      expectedGenesisHash: context.genesisHash.slice(0, 32),
    }),
  );
  assert.throws(() =>
    compileOphisSolanaWalletTransaction({ ...input, programAddress: address(fixture.owner) }),
  );
});

test('cached chain context and broad mint metadata preserve exact values', async (t) => {
  const context = {
    programAddress: fixture.program,
    genesisHash: fixture.owner,
    blockhash: fixture.owner,
    lastValidBlockHeight: '9007199254740993',
    contextSlot: '80',
  };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(context)));
  const value = await fetchOphisSolanaChainContext('https://native.ophis.example');
  assert.equal(value.lastValidBlockHeight, 9007199254740993n);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          address: fixture.sellMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          decimals: 6,
          extensions: [],
        }),
      ),
  );
  assert.equal(
    (await fetchOphisSolanaMint('https://native.ophis.example', address(fixture.sellMint)))
      .decimals,
    6,
  );
});

test('display units round trip exactly, including maximum atoms and tiny decimals', () => {
  for (const [amount, decimals] of [
    [0n, 0],
    [1n, 9],
    [9007199254740993n, 6],
    [0xffffffffffffffffn, 18],
    [1n, 255],
  ])
    assert.equal(
      parseOphisSolanaAmount(formatOphisSolanaAmount(amount, decimals), decimals),
      amount,
    );
  assert.equal(parseOphisSolanaAmount('1.230000000', 6), 1230000n);
  for (const value of ['1e3', '-1', '0.0000001', '18446744073709551616'])
    assert.throws(() => parseOphisSolanaAmount(value, 6));
});

test('fresh quote limits include fees and apply integer slippage without changing the fixed side', async () => {
  const quote = structuredClone(api.quote);
  quote.from = owner.address;
  quote.expiration = new Date(Date.now() + 60000).toISOString();
  quote.quote.validTo = 0xffffffff;
  const input = {
    programAddress: params.programAddress,
    owner,
    quote,
    sellProgram: TOKEN_PROGRAM_ADDRESS,
    buyProgram: TOKEN_PROGRAM_ADDRESS,
    slippageBps: 50,
  };
  const order = await prepareOphisSolanaOrderFromQuote(input);
  assert.equal(
    order.intent.sellAmount,
    BigInt(quote.quote.sellAmount) + BigInt(quote.quote.feeAmount),
  );
  assert.equal(order.intent.buyAmount, (BigInt(quote.quote.buyAmount) * 9950n) / 10000n);
  quote.quote.kind = 'buy';
  const buy = await prepareOphisSolanaOrderFromQuote(input);
  assert.equal(buy.intent.buyAmount, BigInt(quote.quote.buyAmount));
  assert.equal(
    buy.intent.sellAmount,
    ((BigInt(quote.quote.sellAmount) + BigInt(quote.quote.feeAmount)) * 10050n + 9999n) / 10000n,
  );
  quote.verified = false;
  await assert.rejects(prepareOphisSolanaOrderFromQuote(input));
});

test('mainnet binds the displayed benchmark, cost ceiling and fee tier before creating wallet instructions', async () => {
  const quote = structuredClone(api.quote);
  quote.from = owner.address;
  quote.expiration = new Date(Date.now() + 60_000).toISOString();
  const q = quote.quote;
  q.validTo = Math.floor(Date.now() / 1000) + 600;
  q.sellToken = 'So11111111111111111111111111111111111111112';
  q.buyToken = q.costs.token = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  q.buyAmount = '2700724';
  q.costs.networkFees = '418';
  q.costs.buyTokenAtaCosts = '0';
  q.feeTerms = { baseBps: 1, improvementShareBps: 5000, improvementCapBps: 99 };
  const signed = Buffer.alloc(32);
  signed.write('OPHISPI3');
  signed.writeBigUInt64LE(2700724n, 8);
  signed.writeBigUInt64LE(418n, 16);
  signed.writeBigUInt64LE(1n, 24);
  q.appData = '0x' + signed.toString('hex');
  const input = {
    quote,
    programAddress: 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h',
    owner,
    sellProgram: TOKEN_PROGRAM_ADDRESS,
    buyProgram: TOKEN_PROGRAM_ADDRESS,
    slippageBps: 50,
  };
  const order = await prepareOphisSolanaOrderFromQuote(input);
  assert.deepEqual(Buffer.from(order.intent.appData), signed);
  await assert.rejects(
    prepareOphisSolanaOrderFromQuote({ ...input, sellProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    /classic SPL/,
  );
  await assert.rejects(
    prepareOphisSolanaOrderFromQuote({ ...input, buyProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    /classic SPL/,
  );
  assert.equal(order.intent.buyAmount, 2687220n);
  for (const changed of [
    { buyAmount: '2700725' },
    { appData: '0x' + '12'.repeat(32) },
    { feeTerms: undefined },
    { partiallyFillable: true },
    { kind: 'buy' },
    { feeTerms: { ...q.feeTerms, baseBps: 5 } },
    { feeTerms: { ...q.feeTerms, improvementCapBps: 20 } },
    { costs: { ...q.costs, networkFees: '419' } },
    { costs: { ...q.costs, buyTokenAtaCosts: '1' } },
  ]) {
    await assert.rejects(
      prepareOphisSolanaOrderFromQuote({
        ...input,
        quote: { ...quote, quote: { ...q, ...changed } },
      }),
      /actual-output/,
    );
  }
});

test('agent order binds the owner, exact input, cluster and minimum output before signing', async (t) => {
  const { buildOphisSolanaWalletOrder } = await import('../dist/agent.js');
  const { fetchOphisSolanaSellQuote } = await import('../dist/read.js');
  const reply = structuredClone(api.quote);
  reply.expiration = new Date(Date.now() + 60_000).toISOString();
  reply.quote.validTo = Math.floor(Date.now() / 1000) + 600;
  const genesis = '6xBWwnJVYS5MkXhAYGDCDzoApx1hnCKxg89b1Q3Tnwqg';
  const source = {
    baseUrl: 'http://127.0.0.1',
    owner: reply.from,
    program: fixture.program,
    genesis,
    sellToken: reply.quote.sellToken,
    buyToken: reply.quote.buyToken,
    sellAtoms: '500000',
    minimumBuyAtoms: '980000',
  };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('/quote')) return Response.json(reply);
    if (path.endsWith('/context'))
      return Response.json({
        programAddress: fixture.program,
        genesisHash: genesis,
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: '200',
        contextSlot: '100',
      });
    const mint = path.split('/').at(-1);
    return Response.json({
      address: mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      decimals: 6,
      extensions: [],
    });
  });
  await assert.rejects(buildOphisSolanaWalletOrder({ ...source, genesis: 'wrong' }), /deployment/);
  assert.equal(requests.length, 1);
  await assert.rejects(
    buildOphisSolanaWalletOrder({ ...source, minimumBuyAtoms: '99999999' }),
    /minimum/,
  );
  const built = await buildOphisSolanaWalletOrder(source);
  assert.equal(built.sellAtoms, source.sellAtoms);
  assert.ok(BigInt(built.minimumBuyAtoms) >= BigInt(source.minimumBuyAtoms));
  reply.verified = false;
  await assert.rejects(
    fetchOphisSolanaSellQuote(
      source.baseUrl,
      source.owner,
      source.sellToken,
      source.buyToken,
      source.sellAtoms,
    ),
    /verify/,
  );
  reply.verified = true;
  reply.quote.sellAmount = '10';
  await assert.rejects(buildOphisSolanaWalletOrder(source), /sell amount/);
});

test('order actions use the selected cluster and finalize before reporting a refund', async (t) => {
  let landed = null;
  let height = 90;
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { method, id, params } = JSON.parse(body);
    const context = { slot: 100 };
    const results = {
      getGenesisHash: fixture.owner,
      getLatestBlockhash: {
        context,
        value: { blockhash: fixture.owner, lastValidBlockHeight: 100 },
      },
      getSignatureStatuses: { context, value: [landed] },
      getEpochInfo: { absoluteSlot: 100, blockHeight: height },
    };
    assert.ok(Object.hasOwn(results, method));
    if (method === 'getLatestBlockhash')
      assert.equal(params?.[0]?.commitment ?? 'finalized', 'finalized');
    return Response.json({ jsonrpc: '2.0', id, result: results[method] });
  });
  const endpoint = 'http://localhost:8899';
  const check = () => checkOphisWalletAction(endpoint, fixture.owner, '1'.repeat(64), 100n);
  await assert.rejects(
    fetchOphisWalletActionContext(endpoint, fixture.program, 'wrong'),
    /network mismatch/,
  );
  assert.equal(
    (await fetchOphisWalletActionContext(endpoint, fixture.program, fixture.owner)).contextSlot,
    100n,
  );
  assert.equal(await check(), 'pending');
  height = 101;
  assert.equal(await check(), 'expired');
  landed = { confirmationStatus: 'confirmed', err: null };
  assert.equal(await check(), 'pending');
  landed.confirmationStatus = 'finalized';
  assert.equal(await check(), 'confirmed');
  landed.err = 'AccountNotFound';
  assert.equal(await check(), 'failed');
});
