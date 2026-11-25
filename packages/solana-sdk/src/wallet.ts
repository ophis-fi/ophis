import { getWallets } from '@wallet-standard/app';
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from '@wallet-standard/features';
import type {
  SolanaSignAndSendTransactionFeature,
  SolanaSignTransactionFeature,
  SolanaSignMessageFeature,
} from '@solana/wallet-standard-features';
import {
  address,
  assertIsFullySignedTransaction,
  createNoopSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Instruction,
} from '@solana/kit';
import {
  localWalletRpc,
  OPHIS_LOCAL_WALLET_RPC,
  simulateLocalWalletTransaction,
  waitForLocalConfirmation,
} from './local-rpc.js';
import {
  compileOphisSolanaWalletTransaction,
  type OphisSolanaChainContext,
} from './transaction.js';

type Wallet = ReturnType<ReturnType<typeof getWallets>['get']>[number];
export type OphisSolanaWalletAccount = Wallet['accounts'][number];
export type OphisSolanaWallet = Wallet & {
  features: StandardConnectFeature &
    StandardEventsFeature &
    SolanaSignAndSendTransactionFeature &
    Partial<StandardDisconnectFeature & SolanaSignTransactionFeature & SolanaSignMessageFeature>;
};
export type OphisSolanaWalletChain = `solana:${string}`;

export { getWallets as getOphisSolanaWalletRegistry };

export function isOphisSolanaWallet(wallet: Wallet): wallet is OphisSolanaWallet {
  const features = wallet.features as Partial<OphisSolanaWallet['features']>;
  return (
    typeof features['standard:connect']?.connect === 'function' &&
    typeof features['standard:events']?.on === 'function' &&
    typeof features['solana:signAndSendTransaction']?.signAndSendTransaction === 'function' &&
    Array.isArray(features['solana:signAndSendTransaction'].supportedTransactionVersions) &&
    features['solana:signAndSendTransaction'].supportedTransactionVersions.includes(0)
  );
}

export function ophisSolanaWalletSigner(account: OphisSolanaWalletAccount) {
  return createNoopSigner(address(account.address));
}

export function supportsOphisSolanaAccount(
  wallet: OphisSolanaWallet,
  account: OphisSolanaWalletAccount,
  chain: OphisSolanaWalletChain,
): boolean {
  return (
    wallet.chains.includes(chain) &&
    account.chains.includes(chain) &&
    account.features.includes('solana:signAndSendTransaction')
  );
}

/** Local wallets that expose separate signing submit through the preview's own validator. */
export async function sendOphisSolanaWalletTransaction(input: {
  wallet: OphisSolanaWallet;
  account: OphisSolanaWalletAccount;
  chain: OphisSolanaWalletChain;
  instructions: readonly Instruction[];
  context: OphisSolanaChainContext;
  programAddress: OphisSolanaChainContext['programAddress'];
  expectedGenesisHash: string;
  /** Persist recovery data before the first operation that can broadcast the order. */
  onBeforeBroadcast?: () => void;
}): Promise<string> {
  const { wallet, chain } = input;
  const account = wallet.accounts.find((current) => current.address === input.account.address);
  if (
    !account ||
    !isOphisSolanaWallet(wallet) ||
    !supportsOphisSolanaAccount(wallet, account, chain) ||
    account.publicKey.length !== 32 ||
    getBase58Decoder().decode(account.publicKey) !== account.address
  )
    throw Error('Reconnect a Solana wallet on the selected network');
  const signing = wallet.features['solana:signTransaction'];
  const localRpc =
    chain === 'solana:localnet' &&
    typeof signing?.signTransaction === 'function' &&
    signing.supportedTransactionVersions?.includes(0) &&
    account.features.includes('solana:signTransaction')
      ? await localWalletRpc(input.expectedGenesisHash)
      : undefined;
  // Wallets that preview at finalized commitment must also recognize the signing blockhash.
  const latest = await localRpc?.getLatestBlockhash({ commitment: 'finalized' }).send();
  const transaction = compileOphisSolanaWalletTransaction({
    ...input,
    context: latest ? { ...input.context, ...latest.value } : input.context,
    payer: address(account.address),
  });
  if (localRpc && latest && signing) {
    const decoder = getTransactionDecoder();
    const unsigned = decoder.decode(transaction);
    const original = unsigned.messageBytes.slice();
    await simulateLocalWalletTransaction(
      localRpc,
      unsigned,
      address(account.address),
      latest.context.slot,
    );
    const outputs = await signing
      .signTransaction({
        account,
        chain,
        transaction,
        options: { preflightCommitment: 'confirmed' },
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/simulation failed|failed simulation|blockhash\s*not\s*found/i.test(message))
          throw Error(
            `Simulation passed on Ophis localnet, but the wallet reported a simulation failure. Check the wallet’s Solana RPC (${OPHIS_LOCAL_WALLET_RPC}) and reconnect.`,
          );
        throw error;
      });
    if (outputs.length !== 1 || !(outputs[0]?.signedTransaction instanceof Uint8Array))
      throw Error('Wallet did not return one signed transaction.');
    const signed = decoder.decode(outputs[0].signedTransaction);
    if (
      signed.messageBytes.length !== original.length ||
      original.some((b, i) => b !== signed.messageBytes[i])
    )
      throw Error('Wallet changed the transaction. Request a new quote.');
    assertIsFullySignedTransaction(signed);
    if (!wallet.accounts.some((current) => current.address === account.address))
      throw Error('The wallet account changed. Reconnect before retrying.');
    const options = { commitment: 'confirmed', minContextSlot: latest.context.slot } as const;
    if (!(await localRpc.isBlockhashValid(latest.value.blockhash, options).send()).value)
      throw Error(
        'Your local transaction expired while awaiting approval. Request a fresh quote and approve it again.',
      );
    input.onBeforeBroadcast?.();
    const signature = await localRpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: options.commitment,
        minContextSlot: options.minContextSlot,
        skipPreflight: false,
        maxRetries: 0n,
      })
      .send();
    if (signature !== getSignatureFromTransaction(signed))
      throw Error('Unexpected local transaction signature.');
    await waitForLocalConfirmation(localRpc, signature);
    return signature;
  }
  input.onBeforeBroadcast?.();
  const message = Uint8Array.from(getTransactionDecoder().decode(transaction).messageBytes);
  const outputs = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({
    transaction,
    account,
    chain,
    options: {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
      skipPreflight: false,
      ...(chain === 'solana:localnet' ? { maxRetries: 0 } : {}),
    },
  });
  const signature = outputs[0]?.signature;
  if (outputs.length !== 1 || !(signature instanceof Uint8Array) || signature.length !== 64)
    throw Error('Wallet returned an invalid transaction signature');
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(account.publicKey),
    'Ed25519',
    false,
    ['verify'],
  );
  if (!(await crypto.subtle.verify('Ed25519', key, Uint8Array.from(signature), message)))
    throw Error(
      'The wallet returned a signature for a different transaction. Checking the order on Solana.',
    );
  return getBase58Decoder().decode(signature);
}
