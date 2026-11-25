import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getAddressEncoder } from '@solana/kit';
import { readHoldingLabel } from '../dist/holding-labels.js';
import {
  fetchOphisWalletHoldings,
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
