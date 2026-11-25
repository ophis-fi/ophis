import { generateKeyPairSync, sign } from 'node:crypto';
import { getBase58Decoder, getTransactionDecoder } from '@solana/kit';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isOphisSolanaWallet,
  ophisSolanaWalletSigner,
  sendOphisSolanaWalletTransaction,
  prepareOphisSolanaOrder,
  TOKEN_PROGRAM_ADDRESS,
  readOphisOrderAccount,
  getOrderIntentDecoder,
} from '../dist/index.js';
import fixture from './rust-intent-v054.json' with { type: 'json' };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const account = {
  address: getBase58Decoder().decode(rawKey),
  publicKey: rawKey,
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
    return [
      {
        signature: sign(
          null,
          getTransactionDecoder().decode(input.transaction).messageBytes,
          privateKey,
        ),
      },
    ];
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
  const wrongReceipt = wallet(async () => [{ signature: new Uint8Array(64) }]);
  await assert.rejects(
    sendOphisSolanaWalletTransaction({ ...input, wallet: wrongReceipt }),
    /different transaction/,
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

test('recovery and payout verify the entire intent, program and order PDA on the requested cluster', async (t) => {
  const { getOrderAccountEncoder } =
    await import('../dist/settlement/generated/accounts/orderAccount.js');
  const intent = getOrderIntentDecoder().decode(Buffer.from(fixture.encoded, 'hex'));
  const state = {
    bump: 1,
    cancelled: true,
    amountWithdrawn: 0n,
    amountReceived: 0n,
    createdBy: fixture.owner,
    intent,
  };
  let program = fixture.program;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    if (method === 'getGenesisHash')
      return Response.json({ id, jsonrpc: '2.0', result: fixture.owner });
    assert.equal(method, 'getAccountInfo');
    assert.equal(params[1].commitment ?? 'finalized', 'finalized');
    const data = Buffer.from(getOrderAccountEncoder().encode(state));
    return Response.json({
      id,
      jsonrpc: '2.0',
      result: {
        context: { slot: 9 },
        value: {
          owner: program,
          data: [data.toString('base64'), 'base64'],
          executable: false,
          lamports: 1,
          space: data.length,
        },
      },
    });
  });
  const read = (uid, pda) =>
    readOphisOrderAccount(
      'http://localhost:8899',
      fixture.owner,
      fixture.program,
      uid,
      pda,
      'finalized',
    );
  assert.equal((await read(fixture.uid, fixture.orderPda)).cancelled, true);
  await assert.rejects(read(fixture.uid, fixture.owner), /identity mismatch/);
  await assert.rejects(read('0x' + '5a'.repeat(32), fixture.orderPda), /identity mismatch/);
  state.intent = { ...intent, validTo: intent.validTo + 1 };
  await assert.rejects(read(fixture.uid, fixture.orderPda), /identity mismatch/);
  program = fixture.owner;
  await assert.rejects(read(fixture.uid, fixture.orderPda), /Invalid Solana order account/);
});
