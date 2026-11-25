import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address, createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import {
  prepareOphisSolanaOrder,
  prepareOphisSolanaCancellation,
  prepareOphisSolanaReclaim,
  getOrderIntentDecoder,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
} from '../dist/index.js';

import fixture from './rust-intent-v054.json' with { type: 'json' };
const input = {
  programAddress: address(fixture.program),
  owner: createNoopSigner(address(fixture.owner)),
  sellMint: address(fixture.sellMint),
  sellProgram: TOKEN_PROGRAM_ADDRESS,
  buyMint: address(fixture.buyMint),
  buyProgram: TOKEN_PROGRAM_ADDRESS,
  sellAmount: BigInt(fixture.sellAmount),
  buyAmount: BigInt(fixture.buyAmount),
  validTo: 0xffff_ffff,
  kind: 'sell',
  appData: new Uint8Array(Buffer.from(fixture.appData.slice(2), 'hex')),
};

test('reuses the Rust intent encoding, hash, PDA and actual user payer without RPC', async (t) => {
  t.mock.method(Date, 'now', () => (fixture.validTo - 60) * 1000);
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw Error('unexpected RPC');
  });
  const order = await prepareOphisSolanaOrder({ ...input, validTo: fixture.validTo });
  assert.equal(order.uid, fixture.uid);
  assert.equal(order.orderPda, fixture.orderPda);
  assert.equal(order.payer, fixture.owner);
  assert.equal(order.intent.sellTokenAccount, fixture.sellTokenAccount);
  assert.equal(order.intent.buyTokenAccount, fixture.buyTokenAccount);
  assert.deepEqual(
    Buffer.from(order.instructions.at(-1).data).subarray(1),
    Buffer.from(fixture.encoded, 'hex'),
  );
  assert.equal(order.instructions.at(-1).programAddress, fixture.program);
  assert.equal(order.instructions.at(-1).accounts[1].address, fixture.owner);
  assert.equal(fetch.mock.callCount(), 0);
});

test('preserves exact u64 atoms and supports wallet/provider payer selection', async () => {
  const payer = await generateKeyPairSigner();
  const order = await prepareOphisSolanaOrder({
    ...input,
    payer,
    sellAmount: 9_007_199_254_740_993n,
  });
  const decoded = getOrderIntentDecoder().decode(order.instructions.at(-1).data.subarray(1));
  assert.equal(decoded.sellAmount, 9_007_199_254_740_993n);
  assert.equal(order.payer, payer.address);
  assert.equal(order.instructions.at(-1).accounts[0].address, input.owner.address);
  assert.equal(order.instructions.at(-1).accounts[1].address, payer.address);
});

test('derives Token-2022 accounts and native SOL recipients explicitly', async () => {
  const token = await prepareOphisSolanaOrder({
    ...input,
    sellProgram: TOKEN_2022_PROGRAM_ADDRESS,
    buyProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  assert.equal(token.instructions[0].accounts[5].address, TOKEN_2022_PROGRAM_ADDRESS);
  assert.equal(token.instructions[2].programAddress, TOKEN_2022_PROGRAM_ADDRESS);
  assert.notEqual(token.intent.sellTokenAccount, fixture.sellTokenAccount);
  const native = await prepareOphisSolanaOrder({
    ...input,
    buyMint: SOLANA_NATIVE_ASSET,
    buyProgram: undefined,
  });
  assert.equal(native.instructions.length, 3);
  assert.equal(native.intent.buyTokenAccount, input.owner.address);
});

test('rejects invalid atoms, programs, intent widths and accidental CoW deployments', async () => {
  for (const change of [
    { sellAmount: 0n },
    { buyAmount: -1n },
    { sellAmount: 1n << 64n },
    { sellAmount: 9_007_199_254_740_993 },
    { programAddress: undefined },
    { programAddress: address('Moook87DzJ25dELx3LXJ3dnu5a4ERVFwKo1PWWF4p7Y') },
    { validTo: 0 },
    { validTo: 1.5 },
    { appData: new Uint8Array(31) },
    { kind: 'other' },
    { sellProgram: SOLANA_NATIVE_ASSET },
    { sellMint: SOLANA_NATIVE_ASSET, sellProgram: TOKEN_2022_PROGRAM_ADDRESS },
    { buyMint: SOLANA_NATIVE_ASSET },
    { buyProgram: undefined },
  ])
    await assert.rejects(prepareOphisSolanaOrder({ ...input, ...change }));
});

test('cancels the identical intent and returns rent to its recorded payer', async () => {
  const payer = await generateKeyPairSigner();
  const order = await prepareOphisSolanaOrder({ ...input, payer });
  const cancel = await prepareOphisSolanaCancellation({
    programAddress: input.programAddress,
    owner: input.owner,
    payer,
    intent: order.intent,
  });
  assert.equal(cancel.programAddress, input.programAddress);
  assert.equal(cancel.data[0], 11);
  assert.deepEqual(cancel.data.subarray(1), order.instructions.at(-1).data.subarray(1));
  assert.equal(cancel.accounts[2].address, order.orderPda);
  const existingOnly = await prepareOphisSolanaCancellation({
    ...input,
    intent: order.intent,
    existingOnly: true,
  });
  assert.deepEqual(Array.from(existingOnly.data), [11]);
  assert.equal(existingOnly.accounts[2].address, order.orderPda);
  const reclaim = prepareOphisSolanaReclaim({
    programAddress: input.programAddress,
    orderPda: order.orderPda,
    createdBy: payer.address,
    owner: input.owner,
  });
  assert.equal(reclaim.data[0], 5);
  assert.equal(reclaim.accounts[1].address, payer.address);
});

test('wraps native SOL and creates the order atomically using the wallet signer', async () => {
  const order = await prepareOphisSolanaOrder({ ...input, sellMint: SOLANA_NATIVE_ASSET });
  assert.equal(order.intent.sellMint, WRAPPED_SOL_MINT);
  assert.equal(order.instructions.length, 6);
  assert.equal(order.instructions[1].programAddress, SOLANA_NATIVE_ASSET);
  assert.equal(order.instructions[1].accounts[0].address, input.owner.address);
  assert.equal(Buffer.from(order.instructions[1].data).readBigUInt64LE(4), input.sellAmount);
  assert.equal(order.instructions[2].data[0], 17);
  assert.equal(order.instructions[2].accounts[0].address, order.intent.sellTokenAccount);
});
