import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  address, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage,
  generateKeyPairSigner, getBase64EncodedWireTransaction, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  fetchOphisSolanaChainContext, fetchOphisSolanaOrder, fetchOphisSolanaQuote, fetchOphisSolanaTrades,
  getOrderAccountDecoder, hasConfirmedSolanaPayout, prepareOphisSolanaOrderFromQuote, SOLANA_NATIVE_ASSET, TOKEN_PROGRAM_ADDRESS,
} from '../dist/index.js';

assert.equal(process.env.OPHIS_LOCALNET_TEST, '1', 'Requires the local validator and public gateway fixture');
const api = 'http://127.0.0.1:19690/solana-api';
const rpc = createSolanaRpc('http://127.0.0.1:18899');
const marker = path => JSON.parse(readFileSync(new URL('../../../apps/solana/.local/' + path, import.meta.url)));
const genesis = await rpc.getGenesisHash().send();
assert.equal(marker('localnet-validator-genesis.json').genesis, genesis);
assert.notEqual(genesis, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
const { program, buyMint } = marker('wallet-sdk-fixture.json');
const context = await fetchOphisSolanaChainContext(api);
assert.equal(context.genesisHash, genesis);
const origin = 'https://swap.ophis.fi';
const read = await fetch(api + '/api/v1/solana/context', { headers: { Origin: origin } });
assert.equal(read.status, 200);
assert.equal(read.headers.get('access-control-allow-origin'), origin);
await read.arrayBuffer();
const preflight = await fetch(api + '/api/v1/quote', {
  method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type' },
});
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
assert.match(preflight.headers.get('access-control-allow-headers'), /content-type/i);

async function until(check) {
  const deadline = Date.now() + 100_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(700);
  } while (Date.now() < deadline);
  throw Error('Local settlement or indexing deadline exceeded');
}
async function fund() {
  const owner = await generateKeyPairSigner();
  const sig = await rpc.requestAirdrop(owner.address, 100_000_000n).send();
  await until(async () => {
    const s = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (s) assert.equal(s.err, null);
    return s && ['confirmed', 'finalized'].includes(s.confirmationStatus);
  });
  return owner;
}
async function place(owner) {
  const quote = await fetchOphisSolanaQuote(api, {
    from: owner.address, sellToken: SOLANA_NATIVE_ASSET, buyToken: buyMint, walletCreatesBuyTokenAccount: true,
    side: { kind: 'sell', sellAmountBeforeFee: 20_000_000n }, priceQuality: 'verified',
  });
  assert.equal(quote.verified, true);
  const order = await prepareOphisSolanaOrderFromQuote({
    programAddress: address(program), owner, sellFromNativeSol: true, sellProgram: TOKEN_PROGRAM_ADDRESS,
    buyProgram: TOKEN_PROGRAM_ADDRESS, quote, slippageBps: 50,
  });
  let msg = setTransactionMessageFeePayerSigner(owner, createTransactionMessage({ version: 0 }));
  msg = setTransactionMessageLifetimeUsingBlockhash((await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value, msg);
  const signed = await signTransactionMessageWithSigners(appendTransactionMessageInstructions(order.instructions, msg));
  const start = Date.now();
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  return { owner, order, start };
}
const wallets = await Promise.all([fund(), fund()]);
const orders = await Promise.all(wallets.map(place));
const results = await Promise.all(orders.map(async ({ owner, order, start }) => {
  const received = await until(async () => {
    const a = (await rpc.getAccountInfo(order.orderPda, { commitment: 'confirmed', encoding: 'base64' }).send()).value;
    return a && getOrderAccountDecoder().decode(Buffer.from(a.data[0], 'base64')).amountReceived;
  });
  const confirmationMs = Date.now() - start;
  const trade = await until(async () => {
    const trades = await fetchOphisSolanaTrades(api, owner.address);
    assert(trades.every(x => x.owner === owner.address));
    return trades.find(x => x.orderUid === order.uid);
  });
  assert.equal(BigInt(trade.buyAmount), received);
  const status = await fetchOphisSolanaOrder(api, order.uid);
  assert.equal(status.status, 'fulfilled');
  assert.equal(status.owner, owner.address);
  assert(await hasConfirmedSolanaPayout('http://127.0.0.1:18899', genesis, address(program), status));
  await assert.rejects(hasConfirmedSolanaPayout('http://127.0.0.1:18899', genesis, SOLANA_NATIVE_ASSET, status));
  return { owner: owner.address, uid: order.uid, received: received.toString(), confirmationMs, indexedMs: Date.now() - start };
}));
console.log(JSON.stringify({ genesis, results }, null, 2));
