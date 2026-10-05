import { isStarknetAddress } from '@cowprotocol/common-utils'

import { NearTransfer } from './nearDirect.schemas'
import {
  getNearFundingDeadline,
  getNearTokens,
  getNearTransferStatus,
  hasCurrentNearAssets,
  validateNearTransfer,
} from './nearDirect.service'

import type { StarknetWindowObject } from '@starknet-io/get-starknet-core'

export type StarknetWallet = StarknetWindowObject
const MAINNET = 0x534e5f4d41494en
// Starknet's canonical STRK contract, including when 1Click lists it as native:
// https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/mainnet.json
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'

export class StarknetDepositNotSentError extends Error {}
export class StarknetUserRejectedError extends StarknetDepositNotSentError {}

export async function getStarknetAccount(wallet: StarknetWallet, silent = false): Promise<string> {
  const accounts = await wallet.request({ type: 'wallet_requestAccounts', params: { silent_mode: silent } })
  const chain = await wallet.request({ type: 'wallet_requestChainId' })
  if (BigInt(chain) !== MAINNET) throw new Error('Switch your Starknet wallet to Mainnet, then connect again.')
  if (!accounts[0] || !isStarknetAddress(accounts[0])) throw new Error('Connect an account in your Starknet wallet.')
  return accounts[0]
}

export async function fundNearStarknetTransfer(
  wallet: StarknetWallet,
  transfer: NearTransfer,
  beforeSend: () => Promise<void>,
): Promise<string> {
  const changed = new AbortController()
  const invalidate = (): void => changed.abort()
  wallet.on('accountsChanged', invalidate)
  wallet.on('networkChanged', invalidate)
  try {
    validateNearTransfer(transfer)
    const { response } = transfer
    const token = fundingToken(transfer)
    const deposit = String(response.quote.depositAddress)
    const amount = BigInt(response.quote.amountIn)
    if (!hasCurrentNearAssets(transfer, await getNearTokens()))
      throw new Error('Asset details changed. Review a new quote.')
    if ((await getNearTransferStatus(transfer)).status !== 'PENDING_DEPOSIT')
      throw new Error('A deposit has already been detected. Do not send again.')
    await assertFundingWallet(wallet, response.quoteRequest.refundTo)
    if (getNearFundingDeadline(response) <= Date.now() + 60_000) throw new Error('Quote expired. Do not fund it.')
    await beforeSend()
    try {
      await assertFundingWallet(wallet, response.quoteRequest.refundTo)
      if (getNearFundingDeadline(response) <= Date.now() + 60_000) throw new Error('Quote expired. Do not fund it.')
    } catch (failure) {
      throw new StarknetDepositNotSentError(
        failure instanceof Error ? failure.message : 'Reconnect your Starknet wallet and retry.',
      )
    }
    if (changed.signal.aborted)
      throw new StarknetDepositNotSentError('Your Starknet account or network changed. Reconnect and retry.')
    // The wallet estimates fees and asks for approval. Transfer the exact uint256
    // amount; never convert token units through JavaScript floating point.
    const result = await wallet
      .request({
        type: 'wallet_addInvokeTransaction',
        params: {
          calls: [
            {
              contract_address: token,
              entry_point: 'transfer',
              calldata: [
                deposit,
                `0x${(amount & ((1n << 128n) - 1n)).toString(16)}`,
                `0x${(amount >> 128n).toString(16)}`,
              ],
            },
          ],
        },
      })
      .catch((failure: unknown) => {
        if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 113)
          throw new StarknetUserRejectedError('Transaction declined in your Starknet wallet. No deposit was sent.')
        throw failure
      })
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(result.transaction_hash) || BigInt(result.transaction_hash) === 0n)
      throw new Error('The wallet returned no valid transaction hash. Check your wallet before sending again.')
    return result.transaction_hash
  } finally {
    wallet.off('accountsChanged', invalidate)
    wallet.off('networkChanged', invalidate)
  }
}

async function assertFundingWallet(wallet: StarknetWallet, expected: string): Promise<void> {
  const account = await getStarknetAccount(wallet, true)
  // Starknet felt addresses may be zero-padded differently by the wallet and API.
  if (BigInt(account) !== BigInt(expected)) throw new Error('Connect the Starknet refund wallet before sending.')
}

function fundingToken(transfer: NearTransfer): string {
  const { source, response } = transfer
  const token = starknetTokenContract(source)
  if (
    source.blockchain !== 'starknet' ||
    !token ||
    !isStarknetAddress(token) ||
    response.quote.depositMemo ||
    BigInt(response.quote.amountIn) >= 1n << 256n
  )
    throw new Error('Use the external wallet deposit instructions for this route.')
  if (transfer.fundingStarted || transfer.transactionHash || transfer.status !== 'PENDING_DEPOSIT')
    throw new Error('A deposit may already have been sent. Check your wallet.')
  return token
}

function starknetTokenContract(source: NearTransfer['source']): string | undefined {
  const nativeStrk =
    source.assetId === 'nep141:starknet.omft.near' && source.symbol === 'STRK' && source.decimals === 18
  return source.contractAddress ?? (nativeStrk ? STRK : undefined)
}
