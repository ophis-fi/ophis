import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder } from '@solana/kit';
import { readHoldingLabel } from '../dist/holding-labels.js';
import {
  fetchOphisNativeSellReserve,
  fetchOphisWalletHoldings,
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
test('balances require matching genesis and only include initialized associated accounts', async (t) => {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
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
    const tokenAccount = (pubkey, state) => ({
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
            info: { owner, mint, state, tokenAmount: { amount: '9007199254740993', decimals: 6 } },
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
  await assert.rejects(
    requestOphisLocalTestSol('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', owner),
    /Local test network required/,
  );
  assert.ok(!methods.includes('requestAirdrop'));
});

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
  let program = TOKEN_PROGRAM_ADDRESS;
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
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { id, method } = JSON.parse(init.body);
    if (method === 'getGenesisHash') return Response.json({ jsonrpc: '2.0', id, result: genesis });
    assert.equal(method, 'getMultipleAccounts');
    const account = { owner: TOKEN_PROGRAM_ADDRESS };
    const value = [
      sysvar(rent),
      sysvar(hashes),
      { owner: program },
      hasWrapped ? account : null,
      hasBuy ? account : null,
      null,
    ];
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
  program = TOKEN_2022_PROGRAM_ADDRESS;
  await assert.rejects(
    fetchOphisNativeSellReserve(endpoint, genesis, owner, mint),
    /unallocated Token-2022/,
  );
});
