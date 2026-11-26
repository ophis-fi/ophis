import type { Address, TransactionSigner } from '@solana/kit';
import { checkedQuoteAppData, OPHIS_MAINNET_PROGRAM } from './api.js';
import type { OphisSolanaOrderInput } from './index.js';
import {
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  TOKEN_2022_PROGRAM_ADDRESS,
  type SolanaTokenProgram,
} from './tokens.js';

export function checkedQuoteOrderInput(input: {
  programAddress: Address;
  owner: TransactionSigner;
  payer?: TransactionSigner;
  quote: import('./api.js').OphisSolanaQuote;
  sellProgram: SolanaTokenProgram;
  buyProgram?: SolanaTokenProgram;
  sellFromNativeSol?: boolean;
  slippageBps: number;
}): OphisSolanaOrderInput {
  const { quote } = input;
  const value = quote.quote;
  if (
    !quote.verified ||
    quote.from !== input.owner.address ||
    !Number.isFinite(Date.parse(quote.expiration)) ||
    Date.parse(quote.expiration) <= Date.now()
  )
    throw Error('Request a fresh verified quote for this wallet');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 5000)
    throw Error('Slippage must be an integer from 0 to 5000 bps');
  const sell = BigInt(value.sellAmount) + BigInt(value.feeAmount);
  const buy = BigInt(value.buyAmount);
  const sellAmount =
    value.kind === 'buy' ? (sell * BigInt(10_000 + input.slippageBps) + 9999n) / 10_000n : sell;
  const buyAmount =
    value.kind === 'sell' ? (buy * BigInt(10_000 - input.slippageBps)) / 10_000n : buy;
  if (input.sellFromNativeSol && value.sellToken !== WRAPPED_SOL_MINT)
    throw Error('Native SOL funding requires a wrapped SOL quote');
  const appData = checkedQuoteAppData(input.programAddress, value);
  if (
    input.programAddress === OPHIS_MAINNET_PROGRAM &&
    (input.sellProgram === TOKEN_2022_PROGRAM_ADDRESS ||
      input.buyProgram === TOKEN_2022_PROGRAM_ADDRESS)
  )
    throw Error('Actual-output settlement requires classic SPL tokens or native SOL');
  return {
    programAddress: input.programAddress,
    owner: input.owner,
    ...(input.payer ? { payer: input.payer } : {}),
    sellMint: input.sellFromNativeSol ? SOLANA_NATIVE_ASSET : value.sellToken,
    sellProgram: input.sellProgram,
    buyMint: value.buyToken,
    buyProgram: input.buyProgram,
    ...(value.receiver ? { receiver: value.receiver } : {}),
    sellAmount,
    buyAmount,
    validTo: value.validTo,
    kind: value.kind,
    partiallyFillable: value.partiallyFillable,
    appData,
  };
}
