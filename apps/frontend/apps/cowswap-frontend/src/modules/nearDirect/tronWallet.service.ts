import { TronWeb, utils, type Types } from 'tronweb'
import { UserRejectedRequestError } from 'viem'
import { z } from 'zod'

import { NearTransfer } from './nearDirect.schemas'
import { assertFundingDeadline, handleSourceWalletFailure, prepareSourceFunding } from './sourceWallet.service'
import { TronConnection, TronProvider } from './tronWallet.atoms'

const MAINNET_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc'

export async function assertTronWallet(provider: TronProvider, refund?: string): Promise<string> {
  const web = provider.tronWeb
  const address = web && web.defaultAddress.base58
  if (!web || !address || !TronWeb.isAddress(address) || (refund && address !== refund))
    throw new Error('Connect the refund wallet on Tron mainnet before sending.')
  if ((await web.trx.getBlock(0)).blockID !== MAINNET_GENESIS)
    throw new Error('Select Tron mainnet in your wallet and reconnect.')
  return address
}

export async function fundTronTransfer(
  connection: TronConnection,
  transfer: NearTransfer,
  beforeSend: () => Promise<void>,
): Promise<string> {
  await prepareSourceFunding(transfer, 'tron')
  const { quoteRequest } = transfer.response
  await assertTronWallet(connection.provider, quoteRequest.refundTo)
  const web = connection.provider.tronWeb
  if (!web) throw new Error('Reconnect your Tron wallet.')
  const transaction = await tronDepositTransaction(web, transfer)
  assertTronDepositTransaction(transaction, transfer)
  await beforeSend()
  await assertTronWallet(connection.provider, quoteRequest.refundTo)
  assertFundingDeadline(transfer)
  const expectedHash = transaction.txID
  const signed = await web.trx.sign(transaction).catch((failure: unknown) => {
    // TronLink documents this exact rejection for trx.sign (no numeric code).
    if (failure instanceof Error && failure.message === 'Confirmation declined by user')
      throw new UserRejectedRequestError(failure)
    return handleSourceWalletFailure(failure)
  })
  assertTronDepositTransaction(signed, transfer)
  if (signed.txID !== expectedHash)
    throw new Error('Wallet changed the transaction. Check your wallet before sending again.')
  // A signature may sit in the wallet dialog past the quote deadline. Do not broadcast it then.
  assertFundingDeadline(transfer)
  await assertTronWallet(connection.provider, quoteRequest.refundTo)
  const result = await web.trx.sendRawTransaction(signed)
  if (!result.result || result.txid !== signed.txID)
    throw new Error('Broadcast not confirmed. Check your Tron wallet before sending again.')
  return signed.txID
}

export async function tronDepositTransaction(web: TronWeb, transfer: NearTransfer): Promise<Types.Transaction> {
  const {
    source,
    response: { quote, quoteRequest },
  } = transfer
  const deposit = String(quote.depositAddress)
  const amount = BigInt(quote.amountIn)
  if (amount <= 0n || amount >= 1n << 256n || !TronWeb.isAddress(deposit)) throw new Error('Invalid Tron deposit.')
  if (!source.contractAddress) {
    if (source.assetId !== 'nep141:tron.omft.near' || source.decimals !== 6 || amount > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Unsupported TRX deposit amount.')
    return web.transactionBuilder.sendTrx(deposit, Number(amount), quoteRequest.refundTo)
  }
  if (!TronWeb.isAddress(source.contractAddress)) throw new Error('Invalid Tron token contract.')
  const result = await web.transactionBuilder.triggerSmartContract(
    source.contractAddress,
    'transfer(address,uint256)',
    {},
    [
      { type: 'address', value: deposit },
      { type: 'uint256', value: amount.toString() },
    ],
    quoteRequest.refundTo,
  )
  if (!result.result.result) throw new Error('Unable to prepare Tron token transfer.')
  return result.transaction
}

export function assertTronDepositTransaction(transaction: Types.Transaction, transfer: NearTransfer): void {
  const {
    source,
    response: { quote, quoteRequest },
  } = transfer
  const owner = TronWeb.address.toHex(quoteRequest.refundTo)
  const deposit = TronWeb.address.toHex(String(quote.depositAddress))
  const amount = BigInt(quote.amountIn)
  const contract = source.contractAddress
    ? z.object({
        type: z.literal('TriggerSmartContract'),
        parameter: z.object({
          value: z
            .object({
              owner_address: z.literal(owner),
              contract_address: z.literal(TronWeb.address.toHex(source.contractAddress)),
              data: z.literal(
                `a9059cbb${utils.abi.encodeParams(['address', 'uint256'], [String(quote.depositAddress), amount.toString()]).slice(2)}`,
              ),
              call_value: z.literal(0).optional(),
              call_token_value: z.literal(0).optional(),
              token_id: z.literal(0).optional(),
            })
            .strict(),
        }),
      })
    : z.object({
        type: z.literal('TransferContract'),
        parameter: z.object({
          value: z
            .object({
              owner_address: z.literal(owner),
              to_address: z.literal(deposit),
              amount: z.literal(Number(amount)),
            })
            .strict(),
        }),
      })
  if (
    !/^[0-9a-f]{64}$/.test(transaction.txID) ||
    !utils.transaction.txCheck(transaction) ||
    transaction.raw_data.contract.length !== 1 ||
    transaction.raw_data.expiration <= Date.now()
  )
    throw new Error('Invalid Tron deposit transaction.')
  contract.parse(transaction.raw_data.contract[0])
}
