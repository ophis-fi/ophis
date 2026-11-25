import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  isOphisSolanaWallet,
  ophisSolanaWalletSigner,
  sendOphisSolanaWalletTransaction,
  prepareOphisSolanaOrder,
  TOKEN_PROGRAM_ADDRESS,
} from '../dist/index.js';
const fixture = JSON.parse(readFileSync(new URL('./rust-intent-v054.json', import.meta.url)));
const account = {
  address: fixture.owner,
  publicKey: new Uint8Array(32),
  chains: ['solana:localnet'],
  features: ['solana:signAndSendTransaction'],
};
function wallet(send) {
  return {
    version: '1.0.0',
    name: 'Local fixture',
    icon: 'data:image/svg+xml;base64,',
    accounts: [account],
    chains: account.chains,
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: [0],
        signAndSendTransaction: send,
      },
    },
  };
}
test('Wallet Standard receives one network-bound unsigned order and signs through its own provider', async () => {
  let calls = 0;
  const provider = wallet(async (...inputs) => {
    calls++;
    assert.equal(inputs.length, 1);
    const input = inputs[0];
    assert.equal(input.account, account);
    assert.equal(input.chain, 'solana:localnet');
    assert.equal(input.options.skipPreflight, false);
    assert.equal(input.options.maxRetries, 0);
    assert.equal(input.transaction[65], 0x80);
    assert.deepEqual(input.transaction.subarray(1, 65), new Uint8Array(64));
    return [{ signature: new Uint8Array(64).fill(7) }];
  });
  assert.equal(isOphisSolanaWallet(provider), true);
  const order = await prepareOphisSolanaOrder({
    programAddress: fixture.program,
    owner: ophisSolanaWalletSigner(account),
    sellMint: fixture.sellMint,
    sellProgram: TOKEN_PROGRAM_ADDRESS,
    buyMint: fixture.buyMint,
    buyProgram: TOKEN_PROGRAM_ADDRESS,
    sellAmount: 100n,
    buyAmount: 200n,
    validTo: 0xffffffff,
    kind: 'sell',
  });
  const input = {
    wallet: provider,
    account,
    chain: 'solana:localnet',
    instructions: order.instructions,
    programAddress: fixture.program,
    expectedGenesisHash: fixture.owner,
    context: {
      programAddress: fixture.program,
      genesisHash: fixture.owner,
      blockhash: fixture.owner,
      lastValidBlockHeight: 100n,
      contextSlot: 80n,
    },
  };
  assert.equal(typeof (await sendOphisSolanaWalletTransaction(input)), 'string');
  assert.equal(calls, 1);
  await assert.rejects(sendOphisSolanaWalletTransaction({ ...input, chain: 'solana:mainnet' }));
  await assert.rejects(
    sendOphisSolanaWalletTransaction({ ...input, expectedGenesisHash: fixture.program }),
  );
  provider.accounts = [];
  await assert.rejects(sendOphisSolanaWalletTransaction(input));
  assert.equal(calls, 1);
});
test('incomplete and legacy-only providers are excluded before offering a wallet', () => {
  const provider = wallet(async () => []);
  delete provider.features['solana:signAndSendTransaction'].supportedTransactionVersions;
  assert.equal(isOphisSolanaWallet(provider), false);
  provider.features['solana:signAndSendTransaction'].supportedTransactionVersions = ['legacy'];
  assert.equal(isOphisSolanaWallet(provider), false);
});

test('local approval rejects a changed message or expired blockhash before submission', async (t) => {
  const owner = { ...account, features: [...account.features, 'solana:signTransaction'] };
  const provider = wallet(() => assert.fail('unexpected wallet broadcast'));
  provider.accounts = [owner];
  let changeMessage = true;
  let prompts = 0;
  provider.features['solana:signTransaction'] = {
    supportedTransactionVersions: [0],
    signTransaction: async ({ transaction }) => {
      prompts++;
      const wire = transaction.slice();
      wire.fill(1, 1, 65);
      if (changeMessage) wire[wire.length - 1] ^= 1;
      return [{ signedTransaction: wire }];
    },
  };
  let genesis = fixture.owner;
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:18899');
    const { method, id } = JSON.parse(options.body);
    methods.push(method);
    const results = {
      getGenesisHash: genesis,
      getLatestBlockhash: {
        context: { slot: 95 },
        value: { blockhash: fixture.program, lastValidBlockHeight: 245 },
      },
      simulateTransaction: { context: { slot: 95 }, value: { err: null, logs: [] } },
      isBlockhashValid: { context: { slot: 250 }, value: false },
    };
    assert.ok(Object.hasOwn(results, method), method);
    return Response.json({ id, jsonrpc: '2.0', result: results[method] });
  });
  const input = {
    account: owner,
    wallet: provider,
    chain: 'solana:localnet',
    instructions: [{ programAddress: fixture.program, data: Uint8Array.of(1) }],
    programAddress: fixture.program,
    expectedGenesisHash: genesis,
    context: {
      genesisHash: genesis,
      programAddress: fixture.program,
      blockhash: fixture.owner,
      lastValidBlockHeight: 101n,
      contextSlot: 50n,
    },
  };
  await assert.rejects(sendOphisSolanaWalletTransaction(input), /changed the transaction/);
  changeMessage = false;
  await assert.rejects(sendOphisSolanaWalletTransaction(input), /expired while awaiting approval/);
  genesis = fixture.program;
  await assert.rejects(sendOphisSolanaWalletTransaction(input), /network mismatch/);
  assert.equal(prompts, 2);
  assert.equal(methods.filter((method) => method === 'isBlockhashValid').length, 1);
  assert.ok(!methods.includes('sendTransaction'));
});

test('a missing creation expires only after finalized lifetime and absent signature and PDA', async (t) => {
  const { checkOphisSolanaCreation } = await import('../dist/index.js');
  let tipHeight = 99;
  let status = null;
  let pda = null;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { method, id } = JSON.parse(init.body);
    const ctx = { slot: 400 };
    const results = {
      getGenesisHash: fixture.program,
      getEpochInfo: { absoluteSlot: 400, blockHeight: tipHeight },
      getSignatureStatuses: { context: ctx, value: [status] },
      getAccountInfo: { context: ctx, value: pda },
    };
    assert.ok(method in results);
    return Response.json({ jsonrpc: '2.0', id, result: results[method] });
  });
  const check = () =>
    checkOphisSolanaCreation(
      'http://127.0.0.1:18899',
      fixture.program,
      '1'.repeat(64),
      fixture.owner,
      100n,
    );
  assert.equal(await check(), 'pending');
  tipHeight = 101;
  assert.equal(await check(), 'unconfirmed');
  pda = { data: ['', 'base64'], owner: fixture.program, lamports: 1, executable: false, space: 0 };
  assert.equal(await check(), 'pending');
  status = {
    slot: 395,
    confirmationStatus: 'finalized',
    confirmations: null,
    err: 'AccountNotFound',
  };
  assert.equal(await check(), 'failed');
  status.err = null;
  assert.equal(await check(), 'pending');
});
