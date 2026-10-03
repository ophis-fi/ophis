import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Transaction } from '@mysten/sui/transactions'
import { isValidStructTag, isValidTransactionDigest } from '@mysten/sui/utils'

import { NearTransfer } from './nearDirect.schemas'
import { handleSourceWalletFailure, prepareSourceFunding } from './sourceWallet.service'
import { StandardConnection } from './standardWallet.atoms'
import { assertStandardFundingWallet } from './standardWallet.service'

import type { SuiSignAndExecuteTransactionFeature } from '@mysten/wallet-standard'

const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' })

export async function fundSuiTransfer(
  connection: StandardConnection,
  transfer: NearTransfer,
  beforeSend: () => Promise<void>,
): Promise<string> {
  await prepareSourceFunding(transfer, 'sui')
  assertStandardFundingWallet(connection, transfer, 'sui')
  const tx = suiDepositTransaction(transfer)
  // Resolve coin selection and gas before marking a possible broadcast. Wallets receive a concrete transaction.
  await tx.build({ client })
  const json = await tx.toJSON()
  await beforeSend()
  assertStandardFundingWallet(connection, transfer, 'sui')
  const feature = connection.wallet.features[
    'sui:signAndExecuteTransaction'
  ] as SuiSignAndExecuteTransactionFeature['sui:signAndExecuteTransaction']
  const result = await feature
    .signAndExecuteTransaction({
      transaction: { toJSON: async () => json },
      account: connection.account,
      chain: 'sui:mainnet',
    })
    .catch(handleSourceWalletFailure)
  if (!isValidTransactionDigest(result.digest))
    throw new Error('Wallet returned no valid transaction digest. Check your wallet before sending again.')
  return result.digest
}

export function suiDepositTransaction(transfer: NearTransfer): Transaction {
  const {
    source,
    response: { quote, quoteRequest },
  } = transfer
  const amount = BigInt(quote.amountIn)
  if (amount <= 0n || amount >= 1n << 64n) throw new Error('Amount exceeds Sui token limits.')
  const native = source.assetId === 'nep141:sui.omft.near' && source.decimals === 9
  const type = source.contractAddress ?? (native ? '0x2::sui::SUI' : '')
  if (!isValidStructTag(type)) throw new Error('Unsupported Sui coin type.')
  const tx = new Transaction()
  tx.setSender(quoteRequest.refundTo)
  tx.transferObjects([tx.coin({ type, balance: amount })], String(quote.depositAddress))
  return tx
}
