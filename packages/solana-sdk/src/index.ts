import { address, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getApproveInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';
import { getSyncNativeInstruction } from '@solana-program/token';
import { checkedQuoteAppData, OPHIS_MAINNET_PROGRAM } from './api.js';
import { identifyOphisSolanaOrder, resolveOrderPda } from './settlement/hooked.js';
import { encodeFlags, OrderKind } from './settlement/order.js';
import { findStatePda } from './settlement/generated/pdas/state.js';
import type { OrderIntent } from './settlement/generated/types/orderIntent.js';
import { getCreateOrderInstructionAsync } from './settlement/generated/instructions/createOrder.js';
import {
  CANCEL_ORDER_DISCRIMINATOR,
  getCancelOrderInstructionAsync,
} from './settlement/generated/instructions/cancelOrder.js';
import { getReclaimOrderInstruction } from './settlement/generated/instructions/reclaimOrder.js';

import {
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  type SolanaTokenProgram,
} from './tokens.js';
export {
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  type SolanaTokenProgram,
} from './tokens.js';

export interface OphisSolanaOrderInput {
  programAddress: Address;
  owner: TransactionSigner;
  /** Chosen before signing; defaults to the user's wallet. A wallet/provider may pay instead. */
  payer?: TransactionSigner;
  sellMint: Address;
  sellProgram: SolanaTokenProgram;
  buyMint: Address;
  /** Omit for a native SOL payout. */
  buyProgram?: SolanaTokenProgram;
  receiver?: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  kind: 'sell' | 'buy';
  partiallyFillable?: boolean;
  appData?: Uint8Array;
}

function deployment(value: Address): Address {
  const program = address(value);
  if (
    [
      'Moook87DzJ25dELx3LXJ3dnu5a4ERVFwKo1PWWF4p7Y',
      'J516Mv7YvvvJyMvNEca8tWNTJyDHbFpzwDZD96BNfR3w',
    ].includes(program)
  ) {
    throw new Error('Supply the Ophis-owned settlement deployment');
  }
  return program;
}

function tokenProgram(value: SolanaTokenProgram): SolanaTokenProgram {
  if (value !== TOKEN_PROGRAM_ADDRESS && value !== TOKEN_2022_PROGRAM_ADDRESS)
    throw new Error('Unsupported token program');
  return value;
}

function amount(value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error('Amounts must be positive u64 bigint atoms');
}

/** Builds user-funded instructions only. Does not fetch, sign, submit or select a hosted service. */
export async function prepareOphisSolanaOrder(input: OphisSolanaOrderInput) {
  const programAddress = deployment(input.programAddress);
  const owner = address(input.owner.address);
  const payer = input.payer ?? input.owner;
  address(payer.address);
  const requestedSell = address(input.sellMint);
  const nativeSell = requestedSell === SOLANA_NATIVE_ASSET;
  const sellMint = nativeSell ? WRAPPED_SOL_MINT : requestedSell;
  const buyMint = address(input.buyMint);
  const sellProgram = tokenProgram(input.sellProgram);
  if (nativeSell && sellProgram !== TOKEN_PROGRAM_ADDRESS)
    throw new Error('Native SOL wrapping requires the classic token program');
  if (requestedSell === buyMint || sellMint === buyMint)
    throw new Error('Sell and buy mints must differ');
  if (
    buyMint === SOLANA_NATIVE_ASSET
      ? input.buyProgram !== undefined
      : input.buyProgram === undefined
  )
    throw new Error('Specify a token program only for an SPL buy');
  amount(input.sellAmount);
  amount(input.buyAmount);
  if (
    !Number.isInteger(input.validTo) ||
    input.validTo <= Math.floor(Date.now() / 1000) ||
    input.validTo > 0xffff_ffff
  )
    throw new Error('validTo must be a future u32 timestamp');
  if (input.kind !== 'sell' && input.kind !== 'buy') throw new Error('Invalid order kind');
  const appData = input.appData ?? new Uint8Array(32);
  if (!(appData instanceof Uint8Array) || appData.length !== 32)
    throw new Error('appData must contain 32 bytes');
  const receiver = address(input.receiver ?? owner);
  const [sellTokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: sellMint,
    tokenProgram: sellProgram,
  });
  const buyProgram = input.buyProgram === undefined ? undefined : tokenProgram(input.buyProgram);
  const buyTokenAccount =
    buyProgram === undefined
      ? receiver
      : (
          await findAssociatedTokenPda({ owner: receiver, mint: buyMint, tokenProgram: buyProgram })
        )[0];
  const intent: OrderIntent = {
    owner,
    sellTokenAccount,
    sellMint,
    buyTokenAccount,
    buyMint,
    sellAmount: input.sellAmount,
    buyAmount: input.buyAmount,
    validTo: input.validTo,
    flags: encodeFlags({
      kind: input.kind === 'sell' ? OrderKind.Sell : OrderKind.Buy,
      partiallyFillable: input.partiallyFillable ?? false,
    }),
    appData: new Uint8Array(appData),
  };
  const { uid, orderPda } = await identifyOphisSolanaOrder(programAddress, intent);
  const [statePda] = await findStatePda({ programAddress });
  const instructions: Instruction[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      owner,
      mint: sellMint,
      tokenProgram: sellProgram,
      ata: sellTokenAccount,
    }),
  ];
  if (nativeSell)
    instructions.push(
      getTransferSolInstruction({
        source: input.owner,
        destination: sellTokenAccount,
        amount: input.sellAmount,
      }),
      getSyncNativeInstruction({ account: sellTokenAccount }),
    );
  if (buyProgram !== undefined)
    instructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: receiver,
        mint: buyMint,
        tokenProgram: buyProgram,
        ata: buyTokenAccount,
      }),
    );
  instructions.push(
    getApproveInstruction(
      {
        source: sellTokenAccount,
        delegate: statePda,
        owner: input.owner,
        amount: input.sellAmount,
      },
      { programAddress: sellProgram },
    ),
    await getCreateOrderInstructionAsync(
      { owner: input.owner, createdBy: payer, intent, orderPda },
      { programAddress },
    ),
  );
  return { intent, uid, orderPda, statePda, payer: payer.address, instructions };
}

/** A cancellation also prevents creation of this intent when its order is still missing. */
export async function prepareOphisSolanaCancellation(input: {
  programAddress: Address;
  owner: TransactionSigner;
  payer?: TransactionSigner;
  intent: OrderIntent;
  existingOnly?: boolean;
}) {
  const programAddress = deployment(input.programAddress);
  if (input.owner.address !== input.intent.owner)
    throw new Error('The intent owner must authorize cancellation');
  const orderPda = (await resolveOrderPda({ programAddress, args: { intent: input.intent } }))
    .value;
  const instruction = await getCancelOrderInstructionAsync(
    { owner: input.owner, createdBy: input.payer ?? input.owner, orderPda, intent: input.intent },
    { programAddress },
  );
  // An empty cancellation payload cannot recreate a closed order or charge rent again.
  return input.existingOnly ? { ...instruction, data: CANCEL_ORDER_DISCRIMINATOR } : instruction;
}

/** Rent returns to the order account's recorded createdBy, including an external wallet payer. */
export function prepareOphisSolanaReclaim(input: {
  programAddress: Address;
  orderPda: Address;
  createdBy: Address;
  owner?: TransactionSigner;
}) {
  return getReclaimOrderInstruction(
    {
      orderPda: address(input.orderPda),
      reclaimRecipient: address(input.createdBy),
      owner: input.owner,
    },
    { programAddress: deployment(input.programAddress) },
  );
}

export { getOrderAccountDecoder } from './settlement/generated/accounts/orderAccount.js';
export {
  getOrderIntentEncoder,
  getOrderIntentDecoder,
} from './settlement/generated/types/orderIntent.js';
export type { OrderIntent };

export {
  checkedQuoteAppData,
  OPHIS_MAINNET_PROGRAM,
  fetchOphisSolanaQuote,
  fetchOphisSolanaOrder,
  type OphisSolanaQuoteRequest,
  type OphisSolanaQuote,
  type OphisSolanaOrder,
} from './api.js';

export {
  compileOphisSolanaWalletTransaction,
  type OphisSolanaChainContext,
} from './transaction.js';

export {
  OphisSolanaHttpError,
  fetchOphisSolanaChainContext,
  fetchOphisSolanaMint,
  type OphisSolanaMintMetadata,
} from './api.js';

/** Applies the displayed slippage to a fresh verified quote before preparing user-paid instructions. */
export async function prepareOphisSolanaOrderFromQuote(input: {
  programAddress: Address;
  owner: TransactionSigner;
  payer?: TransactionSigner;
  quote: import('./api.js').OphisSolanaQuote;
  sellProgram: SolanaTokenProgram;
  buyProgram?: SolanaTokenProgram;
  sellFromNativeSol?: boolean;
  slippageBps: number;
}) {
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
  return prepareOphisSolanaOrder({
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
  });
}

export { parseOphisSolanaAmount, formatOphisSolanaAmount } from './amounts.js';

export {
  getOphisSolanaWalletRegistry,
  isOphisSolanaWallet,
  ophisSolanaWalletSigner,
  supportsOphisSolanaAccount,
  sendOphisSolanaWalletTransaction,
  type OphisSolanaWallet,
  type OphisSolanaWalletAccount,
  type OphisSolanaWalletChain,
} from './wallet.js';
export { address as solanaAddress } from '@solana/kit';

export { fetchOphisSolanaTrades, type OphisSolanaTrade } from './trades.js';

export {
  fetchOphisWalletHoldings,
  fetchOphisNativeSellReserve,
  requestOphisLocalTestSol,
  type OphisWalletHolding,
} from './holdings.js';
export { OPHIS_LOCAL_WALLET_RPC, previewOphisLocalOrder } from './local-rpc.js';

export {
  hasConfirmedSolanaPayout,
  checkOphisSolanaCreation,
  fetchOphisWalletActionContext,
  fetchOphisWalletActionReceipt,
  checkOphisWalletAction,
} from './local-rpc.js';

export { identifyOphisSolanaOrder } from './settlement/hooked.js';
export { readOphisOrderAccount } from './local-rpc.js';
export { readOphisSellAllowance, verifyOphisMintMetadata } from './holdings.js';
