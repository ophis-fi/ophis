import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  address,
  getTransactionDecoder,
  getBase58Encoder,
  signTransaction,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  prepareOphisSolanaOrder,
  prepareOphisSolanaOrderFromQuote,
  prepareOphisSolanaCancellation,
  prepareOphisSolanaReclaim,
  TOKEN_PROGRAM_ADDRESS,
  SOLANA_NATIVE_ASSET,
  fetchOphisSolanaQuote,
  fetchOphisSolanaOrder,
  fetchOphisSolanaChainContext,
  fetchOphisSolanaMint,
  sendOphisSolanaWalletTransaction,
} from '../dist/index.js';

assert.equal(process.env.OPHIS_LOCALNET_TEST, '1', 'Localnet test is opt-in');
const native = new URL('../../../apps/solana/', import.meta.url);
const marker = JSON.parse(readFileSync(new URL('.local/localnet-validator-genesis.json', native)));
const endpoint = 'http://127.0.0.1:18899';
const rpc = createSolanaRpc(endpoint);
assert.equal(marker.rpc, endpoint);
const genesis = await rpc.getGenesisHash().send();
assert.notEqual(genesis, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
assert.equal(genesis, marker.genesis);
// Check the local cluster before reading its disposable wallet key.
const fixture = JSON.parse(readFileSync(new URL('.local/wallet-sdk-fixture.json', native)));
assert.equal(fixture.genesis, genesis);
const owner = await createKeyPairSignerFromBytes(new Uint8Array(fixture.walletKeypair));
assert.equal(owner.address, fixture.wallet);
const input = {
  programAddress: address(fixture.program),
  owner,
  sellMint: address(fixture.sellMint),
  sellProgram: TOKEN_PROGRAM_ADDRESS,
  buyMint: address(fixture.buyMint),
  buyProgram: TOKEN_PROGRAM_ADDRESS,
  kind: 'sell',
  validTo: Math.floor(Date.now() / 1000) + 1800,
};
const delay = () => new Promise((resolve) => setTimeout(resolve, 250));
async function confirmed(signature) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (status) {
      assert.equal(status.err, null);
      if (['confirmed', 'finalized'].includes(status.confirmationStatus)) return signature;
    }
    await delay();
  }
  throw Error('Local transaction confirmation timed out');
}
async function sendDirect(instructions, payer) {
  const lifetime = (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
  let message = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayerSigner(payer, message);
  message = setTransactionMessageLifetimeUsingBlockhash(lifetime, message);
  message = appendTransactionMessageInstructions(instructions, message);
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  assert.ok(Buffer.from(wire, 'base64').length <= 1232);
  const fee = (
    await rpc
      .getFeeForMessage(Buffer.from(signed.messageBytes).toString('base64'), {
        commitment: 'confirmed',
      })
      .send()
  ).value;
  assert.notEqual(fee, null);
  const signature = await confirmed(
    await rpc
      .sendTransaction(wire, {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
        maxRetries: 0n,
      })
      .send(),
  );
  return { signature, fee };
}
const api = 'http://127.0.0.1:19680';
const metadata = await fetchOphisSolanaMint(api, input.sellMint);
assert.equal(metadata.tokenProgram, TOKEN_PROGRAM_ADDRESS);
assert.equal(metadata.decimals, 6);
const walletAccount = {
  address: owner.address,
  publicKey: new Uint8Array(32),
  chains: ['solana:localnet'],
  features: ['solana:signAndSendTransaction'],
};
let walletStandardSubmissions = 0;
let walletFee;
const wallet = {
  accounts: [walletAccount],
  chains: ['solana:localnet'],
  features: {
    'solana:signAndSendTransaction': {
      async signAndSendTransaction({ transaction, chain, account }) {
        assert.equal(chain, 'solana:localnet');
        assert.equal(account, walletAccount);
        const signed = await signTransaction(
          [owner.keyPair],
          getTransactionDecoder().decode(transaction),
        );
        walletFee = (
          await rpc
            .getFeeForMessage(Buffer.from(signed.messageBytes).toString('base64'), {
              commitment: 'confirmed',
            })
            .send()
        ).value;
        const signature = await confirmed(
          await rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed), {
              encoding: 'base64',
              preflightCommitment: 'confirmed',
              maxRetries: 0n,
            })
            .send(),
        );
        walletStandardSubmissions++;
        return [{ signature: getBase58Encoder().encode(signature) }];
      },
    },
  },
};
async function send(instructions, payer) {
  const externalSigner = instructions.some((instruction) =>
    instruction.accounts?.some((account) => account.role >= 2 && account.address !== owner.address),
  );
  if (payer.address !== owner.address || externalSigner) return sendDirect(instructions, payer);
  const context = await fetchOphisSolanaChainContext(api);
  walletFee = undefined;
  const signature = await sendOphisSolanaWalletTransaction({
    wallet,
    account: walletAccount,
    chain: 'solana:localnet',
    instructions,
    context,
    programAddress: input.programAddress,
    expectedGenesisHash: genesis,
  });
  assert.equal(typeof walletFee, 'bigint');
  return { signature, fee: walletFee };
}
const provider = await generateKeyPairSigner();
await confirmed(await rpc.requestAirdrop(provider.address, 1_000_000_000n).send());
const cancellationOrder = await prepareOphisSolanaOrder({
  ...input,
  payer: provider,
  sellAmount: 1n,
  buyAmount: 0xffff_ffff_ffff_ffffn,
});
await send(cancellationOrder.instructions, provider);
const account = (
  await rpc
    .getAccountInfo(cancellationOrder.orderPda, { encoding: 'base64', commitment: 'confirmed' })
    .send()
).value;
assert.ok(account);
const rent = account.lamports;
await send(
  [
    await prepareOphisSolanaCancellation({
      programAddress: input.programAddress,
      owner,
      payer: provider,
      intent: cancellationOrder.intent,
    }),
  ],
  owner,
);
const providerBefore = (await rpc.getBalance(provider.address, { commitment: 'confirmed' }).send())
  .value;
await send(
  [
    prepareOphisSolanaReclaim({
      programAddress: input.programAddress,
      owner,
      orderPda: cancellationOrder.orderPda,
      createdBy: provider.address,
    }),
  ],
  owner,
);
const providerAfter = (await rpc.getBalance(provider.address, { commitment: 'confirmed' }).send())
  .value;
assert.equal(providerAfter - providerBefore, rent);
assert.equal(
  (
    await rpc
      .getAccountInfo(cancellationOrder.orderPda, { encoding: 'base64', commitment: 'confirmed' })
      .send()
  ).value,
  null,
);
const quote = await fetchOphisSolanaQuote('http://127.0.0.1:19680', {
  from: owner.address,
  sellToken: input.sellMint,
  buyToken: input.buyMint,
  side: { kind: 'sell', sellAmountBeforeFee: 200_000n },
});
assert.equal(quote.verified, true);
const previousUid = process.env.OPHIS_LOCAL_PREVIOUS_ORDER_UID;
if (previousUid)
  assert.equal(
    (await fetchOphisSolanaOrder('http://127.0.0.1:19680', previousUid)).status,
    'fulfilled',
  );
assert.deepEqual(quote.quote.feeTerms, {
  baseBps: 5,
  improvementShareBps: 5000,
  improvementCapBps: 99,
});
const order = await prepareOphisSolanaOrderFromQuote({
  ...input,
  quote,
  slippageBps: 500,
});
const creation = (await send(order.instructions, owner)).signature;
const nativeSell = await prepareOphisSolanaOrder({
  ...input,
  sellMint: SOLANA_NATIVE_ASSET,
  sellAmount: 20_000_000n,
  buyAmount: 300_000n,
});
assert.equal(
  (
    await rpc
      .getAccountInfo(nativeSell.intent.sellTokenAccount, {
        encoding: 'base64',
        commitment: 'confirmed',
      })
      .send()
  ).value,
  null,
);
const nativeSellQuote = await fetchOphisSolanaQuote('http://127.0.0.1:19680', {
  from: owner.address,
  sellToken: SOLANA_NATIVE_ASSET,
  buyToken: input.buyMint,
  side: { kind: 'sell', sellAmountBeforeFee: 20_000_000n },
});
assert.equal(nativeSellQuote.verified, true, 'native SOL must verify before its wallet has wSOL');
await send(nativeSell.instructions, owner);
const nativeBuyQuote = await fetchOphisSolanaQuote('http://127.0.0.1:19680', {
  from: owner.address,
  sellToken: input.buyMint,
  buyToken: SOLANA_NATIVE_ASSET,
  side: { kind: 'sell', sellAmountBeforeFee: 200_000n },
});
assert.equal(nativeBuyQuote.verified, true);
const nativeBuy = await prepareOphisSolanaOrder({
  ...input,
  sellMint: input.buyMint,
  buyMint: SOLANA_NATIVE_ASSET,
  buyProgram: undefined,
  sellAmount: 200_000n,
  buyAmount: 8_000_000n,
});
const nativeBuyWalletBefore = (
  await rpc.getBalance(owner.address, { commitment: 'confirmed' }).send()
).value;
const nativeBuyCreation = await send(nativeBuy.instructions, owner);
const nativeBuyRent = (
  await rpc
    .getAccountInfo(nativeBuy.orderPda, { encoding: 'base64', commitment: 'confirmed' })
    .send()
).value.lamports;
process.stdout.write(
  JSON.stringify({
    genesis,
    uid: order.uid,
    owner: owner.address,
    creation,
    cancelledUid: cancellationOrder.uid,
    externalWalletPayer: provider.address,
    rentReturnedToActualPayer: rent.toString(),
    nativeSellUid: nativeSell.uid,
    nativeBuyUid: nativeBuy.uid,
    nativeSellVerifiedBeforeWsolFunding: nativeSellQuote.verified,
    nativeBuyVerified: nativeBuyQuote.verified,
    nativeBuyWalletBefore: nativeBuyWalletBefore.toString(),
    nativeBuyCreationFee: nativeBuyCreation.fee.toString(),
    nativeBuyRent: nativeBuyRent.toString(),
    creationVersion: 'v0',
    walletStandardSubmissions,
    cachedMintMetadataVerified: true,
    verifiedQuoteThroughSdk: quote.verified,
    providerRequests: 0,
  }) + '\n',
);
