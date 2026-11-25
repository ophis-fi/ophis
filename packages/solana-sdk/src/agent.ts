import { createNoopSigner, getBase64Decoder } from '@solana/kit';
import { atoms, fetchOphisSolanaChainContext, fetchOphisSolanaMint, key } from './api.js';
import { prepareOphisSolanaOrderFromQuote } from './index.js';
import { fetchOphisSolanaSellQuote } from './read.js';
import { SOLANA_NATIVE_ASSET, TOKEN_PROGRAM_ADDRESS } from './tokens.js';
import { compileOphisSolanaWalletTransaction } from './transaction.js';

/** User-funded exact-input intent, with an explicit output floor in buy-token atoms. */
export async function buildOphisSolanaWalletOrder(input: {
  baseUrl: string;
  program: string;
  genesis: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAtoms: string;
  minimumBuyAtoms: string;
}) {
  const minimum = BigInt(atoms(input.minimumBuyAtoms, true));
  const programAddress = key(input.program);
  const context = await fetchOphisSolanaChainContext(input.baseUrl);
  if (context.programAddress !== programAddress || context.genesisHash !== input.genesis)
    throw Error('Trading service does not match the configured Ophis deployment');
  const quote = await fetchOphisSolanaSellQuote(
    input.baseUrl,
    input.owner,
    input.sellToken,
    input.buyToken,
    input.sellAtoms,
  );
  const quoted = BigInt(quote.quote.buyAmount);
  if (quoted < minimum) throw Error('Verified quote falls below your minimum received');
  const programFor = async (mint: typeof programAddress) =>
    mint === SOLANA_NATIVE_ASSET
      ? TOKEN_PROGRAM_ADDRESS
      : (await fetchOphisSolanaMint(input.baseUrl, mint)).tokenProgram;
  const nativeSell = input.sellToken === 'SOL' || input.sellToken === SOLANA_NATIVE_ASSET;
  const [sellProgram, buyProgram] = await Promise.all([
    nativeSell ? TOKEN_PROGRAM_ADDRESS : programFor(quote.quote.sellToken),
    quote.quote.buyToken === SOLANA_NATIVE_ASSET ? undefined : programFor(quote.quote.buyToken),
  ]);
  const order = await prepareOphisSolanaOrderFromQuote({
    programAddress,
    owner: createNoopSigner(key(input.owner)),
    quote,
    sellProgram,
    buyProgram,
    sellFromNativeSol: nativeSell,
    slippageBps: Number(((quoted - minimum) * 10_000n) / quoted),
  });
  if (order.intent.buyAmount < minimum)
    throw Error('Order minimum differs from the requested floor');
  const wire = compileOphisSolanaWalletTransaction({
    instructions: order.instructions,
    payer: order.payer,
    programAddress,
    expectedGenesisHash: input.genesis,
    context,
  });
  return {
    uid: order.uid,
    orderPda: order.orderPda,
    owner: input.owner,
    program: programAddress,
    genesis: context.genesisHash,
    sellAtoms: String(order.intent.sellAmount),
    minimumBuyAtoms: String(order.intent.buyAmount),
    validTo: order.intent.validTo,
    lastValidBlockHeight: String(context.lastValidBlockHeight),
    quote,
    unsignedTransactionBase64: getBase64Decoder().decode(wire),
  };
}
