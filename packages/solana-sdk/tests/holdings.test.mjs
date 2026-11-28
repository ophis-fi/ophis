import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder } from '@solana/kit';
import { readHoldingLabel } from '../dist/holding-labels.js';
import {
  fetchOphisNativeSellReserve,
  fetchOphisOrderSolReserve,
  fetchOphisWalletSwapCosts,
  SOLANA_NATIVE_ASSET,
  fetchOphisWalletHoldings,
  fetchOphisMarketSellMints,
  readOphisSellAllowance,
  verifyOphisMintMetadata,
  requestOphisLocalTestSol,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../dist/index.js';
import { findAssociatedTokenPda } from '@solana-program/token';

const mint = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const owner = address('So11111111111111111111111111111111111111112');
const genesis = '6xBWwnJVYS5MkXhAYGDCDzoApx1hnCKxg89b1Q3Tnwqg';
const endpoint = 'http://127.0.0.1:18899';
test('labels require an intact metadata prefix for the exact mint', () => {
  const data = Buffer.alloc(115);
  data[0] = 4;
  data.set(getAddressEncoder().encode(mint), 33);
  data.writeUInt32LE(32, 65);
  data.write('Example', 69);
  data.writeUInt32LE(10, 101);
  data.write('ABC', 105);
  assert.deepEqual(readHoldingLabel(data, mint), { name: 'Example', symbol: 'ABC' });
  assert.equal(readHoldingLabel(data, owner), undefined);
  assert.equal(readHoldingLabel(data.subarray(0, 103), mint), undefined);
});
test('wallet holdings and the legacy account inventory use initialized associated accounts', async (t) => {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [emptyAta] = await findAssociatedTokenPda({
    owner,
    mint: owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    methods.push(method);
    if (method === 'getMultipleAccounts')
      return Response.json({
        jsonrpc: '2.0',
        id,
        error: { code: -1, message: 'metadata unavailable' },
      });
    const tokenAccount = (
      pubkey,
      state,
      accountMint = mint,
      amount = '9007199254740993',
      authority = owner,
    ) => ({
      pubkey,
      account: {
        owner: TOKEN_PROGRAM_ADDRESS,
        lamports: 100,
        executable: false,
        space: 165,
        rentEpoch: 0,
        data: {
          program: 'spl-token',
          parsed: {
            type: 'account',
            info: {
              owner: authority,
              mint: accountMint,
              state,
              tokenAmount: { amount, decimals: 6 },
            },
          },
        },
      },
    });
    const result =
      method === 'getGenesisHash'
        ? genesis
        : {
            context: { slot: 6 },
            value:
              method === 'getBalance'
                ? 10
                : params[1].programId === TOKEN_2022_PROGRAM_ADDRESS
                  ? []
                  : [
                      tokenAccount(ata, 'initialized'),
                      tokenAccount(owner, 'initialized'),
                      tokenAccount(ata, 'frozen'),
                      tokenAccount(emptyAta, 'initialized', owner, '0'),
                      tokenAccount(ata, 'initialized', mint, '123', genesis),
                    ],
          };
    return Response.json({ id, jsonrpc: '2.0', result });
  });
  await assert.rejects(fetchOphisWalletHoldings(endpoint, 'wrong', owner), /network mismatch/);
  assert.deepEqual(methods, ['getGenesisHash']);
  const holdings = await fetchOphisWalletHoldings(endpoint, genesis, owner);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].atoms, 10n);
  assert.deepEqual(holdings[1], { mint, atoms: 9007199254740993n, decimals: 6 });
  const before = methods.length;
  assert.deepEqual(await fetchOphisMarketSellMints(endpoint, genesis, owner), [mint, owner]);
  assert.deepEqual(methods.slice(before), ['getGenesisHash', 'getTokenAccountsByOwner']);
  await assert.rejects(
    requestOphisLocalTestSol('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', owner),
    /Local test network required/,
  );
  assert.ok(!methods.includes('requestAirdrop'));
});

for (const stalled of ['getGenesisHash', 'getTokenAccountsByOwner']) {
  test(`sell availability times out when ${stalled} stalls`, { timeout: 2_000 }, async (t) => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
      assert.ok(milliseconds > 0 && milliseconds <= 10_000);
      return deadline.signal;
    });
    let fetchSignal;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const { id, method } = JSON.parse(init.body);
      if (method !== stalled) return Response.json({ jsonrpc: '2.0', id, result: genesis });
      fetchSignal = init.signal;
      queueMicrotask(() => deadline.abort());
      return new Promise((_, reject) =>
        fetchSignal.addEventListener('abort', () => reject(fetchSignal.reason), { once: true }),
      );
    });
    await assert.rejects(fetchOphisMarketSellMints(endpoint, genesis, owner));
    assert.equal(fetchSignal?.aborted, true);
  });
}

test('mint decimals and existing SPL allowance come from the configured cluster and canonical account', async (t) => {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const header = Buffer.alloc(115);
  header[44] = 6;
  header[45] = 1;
  const mintInfo = { address: mint, tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 6 };
  const delegate = genesis;
  const info = { owner, mint, delegate, delegatedAmount: { amount: '9007199254740993' } };
  let pubkey = ata;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { id, method } = JSON.parse(init.body);
    const account = { owner: TOKEN_PROGRAM_ADDRESS, lamports: 1, executable: false, space: 165 };
    const results = {
      getGenesisHash: genesis,
      getMultipleAccounts: {
        context: { slot: 4 },
        value: [{ ...account, data: [header.toString('base64'), 'base64'] }],
      },
      getTokenAccountsByOwner: {
        context: { slot: 4 },
        value: [
          {
            pubkey,
            account: {
              ...account,
              data: { program: 'spl-token', parsed: { type: 'account', info } },
            },
          },
        ],
      },
    };
    assert.ok(Object.hasOwn(results, method));
    return Response.json({ id, jsonrpc: '2.0', result: results[method] });
  });
  await verifyOphisMintMetadata(endpoint, genesis, [mintInfo]);
  await assert.rejects(
    verifyOphisMintMetadata(endpoint, genesis, [{ ...mintInfo, decimals: 9 }]),
    /decimals/,
  );
  await assert.rejects(
    verifyOphisMintMetadata(endpoint, genesis, [
      { ...mintInfo, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    ]),
    /program/,
  );
  await assert.rejects(verifyOphisMintMetadata(endpoint, owner, [mintInfo]), /network mismatch/);
  assert.deepEqual(await readOphisSellAllowance(endpoint, genesis, owner, mintInfo), {
    delegate,
    atoms: 9007199254740993n,
  });
  pubkey = owner;
  assert.equal(await readOphisSellAllowance(endpoint, genesis, owner, mintInfo), null);
});

test('native Max reserves current rent only for the payer, order and missing token accounts', async (t) => {
  let hasWrapped = true;
  const program = TOKEN_PROGRAM_ADDRESS;
  let hasBuy = true;
  const sysvar = (bytes) => ({
    owner: 'Sysvar1111111111111111111111111111111111111',
    data: [bytes.toString('base64'), 'base64'],
  });
  const rent = Buffer.alloc(17),
    hashes = Buffer.alloc(48);
  rent.writeBigUInt64LE(5080n);
  rent.writeDoubleLE(1, 8);
  hashes.writeBigUInt64LE(1n);
  hashes.writeBigUInt64LE(5000n, 40);
  const classicBuy = (
    await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  )[0];
  const wrapped = (
    await findAssociatedTokenPda({ owner, mint: owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  )[0];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    if (method === 'getGenesisHash') return Response.json({ jsonrpc: '2.0', id, result: genesis });
    assert.equal(method, 'getMultipleAccounts');
    const account = { owner: TOKEN_PROGRAM_ADDRESS };
    const data = {
      SysvarRent111111111111111111111111111111111: sysvar(rent),
      SysvarRecentB1ockHashes11111111111111111111: sysvar(hashes),
      [mint]: { owner: program },
      [wrapped]: hasWrapped ? account : null,
      [classicBuy]: hasBuy ? account : null,
    };
    const value = params[0].map((key) => data[key] ?? null);
    return Response.json({ jsonrpc: '2.0', id, result: { context: { slot: 10 }, value } });
  });
  const reserve = await fetchOphisNativeSellReserve(endpoint, genesis, owner, mint);
  assert.equal(reserve, 2646600n);
  hasWrapped = false;
  assert.equal(
    await fetchOphisNativeSellReserve(endpoint, genesis, owner, mint),
    reserve + 1488440n,
  );
  hasBuy = false;
  assert.equal(
    await fetchOphisNativeSellReserve(endpoint, genesis, owner, mint),
    reserve + 2n * 1488440n,
  );
  assert.equal(
    await fetchOphisOrderSolReserve(endpoint, genesis, owner, SOLANA_NATIVE_ASSET, false),
    reserve,
  );
  assert.equal(
    await fetchOphisOrderSolReserve(endpoint, genesis, owner, mint, false),
    reserve + 1488440n,
  );
});

test('wallet reserve sizes first-use input and receiving accounts for the actual mint programs', async (t) => {
  const sellMint = address('11111111111111111111111111111112');
  const buyMint = address('11111111111111111111111111111113');
  const solver = address('11111111111111111111111111111114');
  const ata = async (owner, mint, tokenProgram) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
  const solvers = await Promise.all(
    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map((p) => ata(solver, sellMint, p)),
  );
  const receiver = await ata(owner, buyMint, TOKEN_2022_PROGRAM_ADDRESS);
  const rent = Buffer.alloc(17),
    hashes = Buffer.alloc(48);
  rent.writeBigUInt64LE(5080n);
  rent.writeDoubleLE(1, 8);
  hashes.writeBigUInt64LE(1n);
  hashes.writeBigUInt64LE(5000n, 40);
  const sysvar = (bytes) => ({
    owner: 'Sysvar1111111111111111111111111111111111111',
    data: [bytes.toString('base64'), 'base64'],
  });
  const accounts = {
    SysvarRent111111111111111111111111111111111: sysvar(rent),
    SysvarRecentB1ockHashes11111111111111111111: sysvar(hashes),
    [sellMint]: { owner: TOKEN_PROGRAM_ADDRESS },
    [buyMint]: { owner: TOKEN_2022_PROGRAM_ADDRESS },
  };
  let extensions = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    let result;
    if (method === 'getGenesisHash') result = genesis;
    else if (method === 'getMultipleAccounts')
      result = {
        context: { slot: 10 },
        value: params[0].map((key) => accounts[key] ?? null),
      };
    else {
      assert.equal(method, 'getAccountInfo');
      assert.ok([sellMint, buyMint].includes(params[0]));
      assert.deepEqual(params[1], {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        minContextSlot: 10,
      });
      result = {
        context: { slot: 10 },
        value: {
          owner: TOKEN_2022_PROGRAM_ADDRESS,
          data: {
            program: 'spl-token-2022',
            parsed: { type: 'mint', info: { isInitialized: true, extensions } },
          },
        },
      };
    }
    return Response.json({ jsonrpc: '2.0', id, result });
  });
  const costs = () =>
    fetchOphisWalletSwapCosts(endpoint, genesis, owner, buyMint, false, 2, { solver, sellMint });
  const deposit = (size) => BigInt(128 + size) * 5080n;
  const first = await costs();
  await assert.rejects(
    fetchOphisWalletSwapCosts(endpoint, genesis, owner, buyMint, false, 2, {
      solver,
      sellMint,
      sellProgram: TOKEN_2022_PROGRAM_ADDRESS,
      buyProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    /mint owner/,
  );
  await assert.rejects(
    fetchOphisWalletSwapCosts(endpoint, genesis, owner, buyMint, false, 2, {
      solver,
      sellMint,
      sellProgram: TOKEN_PROGRAM_ADDRESS,
      buyProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    /mint owner/,
  );
  assert.equal(first.solverInputRent, deposit(165));
  assert.equal(first.tokenAccountRent, deposit(170));
  assert.equal(
    first.reserve,
    deposit(0) + first.networkFee + first.orderRent + deposit(165) + deposit(170),
  );
  accounts[solvers[0]] = { owner: SOLANA_NATIVE_ASSET, lamports: 12345 };
  assert.equal((await costs()).solverInputRent, deposit(165));
  accounts[solvers[0]] = { owner: TOKEN_PROGRAM_ADDRESS };
  assert.equal((await costs()).solverInputRent, 0n);
  accounts[sellMint] = { owner: TOKEN_2022_PROGRAM_ADDRESS };
  assert.equal((await costs()).solverInputRent, deposit(165)); // The classic ATA belongs to a different program.
  extensions = [
    { extension: 'metadataPointer' },
    { extension: 'transferFeeConfig' },
    { extension: 'transferHook' },
    { extension: 'pausableConfig' },
  ];
  const extended = await costs();
  assert.equal(extended.solverInputRent, deposit(165 + 1 + 12 + 5 + 4));
  assert.equal(extended.tokenAccountRent, deposit(170 + 12 + 5 + 4));
  accounts[receiver] = { owner: TOKEN_2022_PROGRAM_ADDRESS };
  accounts[solvers[1]] = { owner: TOKEN_2022_PROGRAM_ADDRESS };
  assert.equal((await costs()).tokenAccountRent, 0n);
  assert.equal((await costs()).solverInputRent, 0n);
  accounts[solvers[1]] = { owner: owner };
  await assert.rejects(costs, /Unexpected Solana token account owner/);
  delete accounts[solvers[1]];
  extensions = [{ extension: 'unparseableExtension' }];
  await assert.rejects(costs, /Could not read Token-2022 mint extensions/);
});
