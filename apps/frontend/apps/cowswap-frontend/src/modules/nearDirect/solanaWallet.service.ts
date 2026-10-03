import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'

import { NearTransfer } from './nearDirect.schemas'
import { handleSourceWalletFailure, prepareSourceFunding } from './sourceWallet.service'
import { StandardConnection } from './standardWallet.atoms'
import { assertStandardFundingWallet } from './standardWallet.service'

import type { SolanaSignAndSendTransactionFeature } from '@solana/wallet-standard-features'

const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
// Public read RPC; the connected wallet broadcasts and simulates the transaction.
const rpc = createSolanaRpc('https://solana-rpc.publicnode.com')

export async function fundSolanaTransfer(
  connection: StandardConnection,
  transfer: NearTransfer,
  beforeSend: () => Promise<void>,
): Promise<string> {
  await prepareSourceFunding(transfer, 'sol')
  assertStandardFundingWallet(connection, transfer, 'sol')
  if ((await rpc.getGenesisHash().send()) !== SOLANA_GENESIS) throw new Error('Solana RPC is not on mainnet.')
  const instructions = await solanaDepositInstructions(transfer)
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (tx) => setTransactionMessageFeePayer(address(connection.account.address), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  )
  const transaction = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
  const feature = connection.wallet.features[
    'solana:signAndSendTransaction'
  ] as SolanaSignAndSendTransactionFeature['solana:signAndSendTransaction']
  if (!feature.supportedTransactionVersions.includes('legacy'))
    throw new Error('Wallet does not support this Solana transaction.')
  await beforeSend()
  assertStandardFundingWallet(connection, transfer, 'sol')
  const [result] = await feature
    .signAndSendTransaction({
      transaction,
      account: connection.account,
      chain: 'solana:mainnet',
      options: { skipPreflight: false, preflightCommitment: 'confirmed' },
    })
    .catch(handleSourceWalletFailure)
  if (result?.signature.length !== 64 || !result.signature.some(Boolean))
    throw new Error('Wallet returned no valid transaction hash. Check your wallet before sending again.')
  return getBase58Decoder().decode(result.signature)
}

export async function solanaDepositInstructions(transfer: NearTransfer): Promise<Instruction[]> {
  const {
    source,
    response: { quote, quoteRequest },
  } = transfer
  const owner = createNoopSigner(address(quoteRequest.refundTo))
  const deposit = address(String(quote.depositAddress))
  const amount = BigInt(quote.amountIn)
  if (amount <= 0n || amount >= 1n << 64n) throw new Error('Amount exceeds Solana token limits.')
  if (!source.contractAddress) {
    if (source.assetId !== 'nep141:sol.omft.near' || source.decimals !== 9)
      throw new Error('Unknown native Solana asset.')
    return [getTransferSolInstruction({ source: owner, destination: deposit, amount })]
  }
  const mint = address(source.contractAddress)
  const mintAccount = await fetchMint(rpc, mint)
  if (mintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS || mintAccount.data.decimals !== source.decimals)
    throw new Error('Unsupported Solana token program or decimals. Use manual deposit instructions.')
  const [[from], [to]] = await Promise.all([
    findAssociatedTokenPda({ mint, owner: owner.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    findAssociatedTokenPda({ mint, owner: deposit, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
  ])
  return [
    getCreateAssociatedTokenIdempotentInstruction({ payer: owner, ata: to, owner: deposit, mint }),
    getTransferCheckedInstruction({
      source: from,
      mint,
      destination: to,
      authority: owner,
      amount,
      decimals: source.decimals,
    }),
  ]
}
