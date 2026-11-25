import { getOrderAccountDecoder, ORDER_ACCOUNT_DISCRIMINATOR } from './settlement/generated/accounts/orderAccount.js';
import type { OphisSolanaOrder } from './api.js';
import {
  createSolanaRpc,
  getBase64Encoder,
  signature,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type Address,
  type Signature,
  type Transaction,
} from '@solana/kit';
import {
  compileOphisSolanaWalletTransaction,
  type OphisSolanaChainContext,
} from './transaction.js';

export const OPHIS_LOCAL_WALLET_RPC = 'http://127.0.0.1:18899';

export async function matchingRpc(endpoint: string, genesis: string) {
  const rpc = createSolanaRpc(endpoint);
  if ((await rpc.getGenesisHash().send()) !== genesis) throw Error('Solana RPC network mismatch.');
  return rpc;
}

export async function fetchOphisWalletActionContext(
  endpoint: string,
  programAddress: Address,
  genesisHash: string,
): Promise<OphisSolanaChainContext> {
  const rpc = await matchingRpc(endpoint, genesisHash);
  const { context, value } = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
  return { ...value, contextSlot: context.slot, genesisHash, programAddress };
}

export async function checkOphisWalletAction(
  endpoint: string,
  genesis: string,
  tx: string,
  lastHeight: bigint,
) {
  const rpc = await matchingRpc(endpoint, genesis);
  const lookup = () =>
    rpc.getSignatureStatuses([signature(tx)], { searchTransactionHistory: true }).send();
  let receipt = await lookup();
  if (!receipt.value[0]) {
    const tip = await rpc.getEpochInfo({ commitment: 'finalized' }).send();
    if (tip.blockHeight == null || tip.blockHeight <= lastHeight) return 'pending';
    receipt = await lookup();
    if (!receipt.value[0] && receipt.context.slot >= tip.absoluteSlot) return 'expired';
  }
  const status = receipt.value[0];
  if (status?.confirmationStatus !== 'finalized') return 'pending';
  return status.err ? 'failed' : 'confirmed';
}

export async function localWalletRpc(genesis: string) {
  if (genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    throw Error('Local test network required.');
  return matchingRpc(OPHIS_LOCAL_WALLET_RPC, genesis);
}

export async function simulateLocalWalletTransaction(
  rpc: ReturnType<typeof createSolanaRpc>,
  transaction: Transaction,
  payer: Address,
  minContextSlot: bigint,
): Promise<bigint | undefined> {
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      minContextSlot,
      accounts: { encoding: 'base64', addresses: [payer] },
    })
    .send();
  if (value.err) {
    const reason = JSON.stringify(value.err, (_, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
    if (
      /InsufficientFundsFor(Fee|Rent)/.test(reason) ||
      value.logs?.some((line) => line.startsWith('Transfer: insufficient lamports '))
    )
      throw Error(
        'Insufficient SOL for this order. Reduce the SOL sale or add SOL to cover network fees and account rent.',
      );
    throw Error('Ophis local simulation failed: ' + reason);
  }
  const after = value.accounts?.[0];
  return after === null ? 0n : after?.lamports;
}

export async function previewOphisLocalOrder(
  input: Parameters<typeof compileOphisSolanaWalletTransaction>[0],
): Promise<bigint | undefined> {
  const transaction = getTransactionDecoder().decode(compileOphisSolanaWalletTransaction(input));
  const rpc = await localWalletRpc(input.expectedGenesisHash);
  return simulateLocalWalletTransaction(rpc, transaction, input.payer, input.context.contextSlot);
}

export async function waitForLocalConfirmation(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [status] = (await rpc.getSignatureStatuses([signature]).send()).value;
    if (status?.err) throw Error('Local transaction failed: ' + signature);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
      return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw Error('Confirmation is pending. Check the local transaction before retrying: ' + signature);
}

/** A missing index entry is conclusive only after the creation blockhash expires and the PDA is absent. */
export async function checkOphisSolanaCreation(
  endpoint: string,
  genesis: string,
  tx: string,
  orderPda: Address,
  lastValidBlockHeight: bigint,
): Promise<'pending' | 'failed' | 'unconfirmed'> {
  const rpc = await matchingRpc(endpoint, genesis);
  const tip = await rpc.getEpochInfo({ commitment: 'finalized' }).send();
  if (tip.blockHeight == null || tip.blockHeight <= lastValidBlockHeight) return 'pending';
  const statuses = await rpc
    .getSignatureStatuses([signature(tx)], { searchTransactionHistory: true })
    .send();
  if (statuses.context.slot < tip.absoluteSlot) return 'pending';
  const status = statuses.value[0];
  if (status) return status.confirmationStatus === 'finalized' && status.err ? 'failed' : 'pending';
  const account = await rpc
    .getAccountInfo(orderPda, {
      commitment: 'finalized',
      minContextSlot: tip.absoluteSlot,
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
    })
    .send();
  return account.value ? 'pending' : 'unconfirmed';
}

/** The indexed order supplies the canonical PDA. Finalized history follows confirmed delivery. */
export async function hasConfirmedSolanaPayout(endpoint: string, program: Address, order: OphisSolanaOrder): Promise<boolean> {
  const decoder = getOrderAccountDecoder();
  const { value } = await createSolanaRpc(endpoint).getAccountInfo(order.orderPda, {
    commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: decoder.fixedSize },
  }).send();
  if (!value || value.owner !== program) return false;
  const bytes = getBase64Encoder().encode(value.data[0]);
  if (bytes.length !== decoder.fixedSize || bytes[0] !== ORDER_ACCOUNT_DISCRIMINATOR[0]) return false;
  const { intent, amountWithdrawn, amountReceived } = decoder.decode(bytes);
  return intent.owner === order.owner && intent.sellMint === order.sellToken && intent.buyMint === order.buyToken &&
    intent.sellAmount === BigInt(order.sellAmount) && intent.buyAmount === BigInt(order.buyAmount) &&
    amountWithdrawn === intent.sellAmount && amountReceived >= intent.buyAmount && amountReceived > 0n;
}
