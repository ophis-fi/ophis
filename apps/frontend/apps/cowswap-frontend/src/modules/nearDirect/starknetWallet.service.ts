import { STRK_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { isStarknetAddress } from '@cowprotocol/common-utils'

import { UserRejectedRequestError } from 'viem'

import { NearTransfer } from './nearDirect.schemas'
import {
  getNearFundingDeadline,
  getNearTokens,
  getNearTransferStatus,
  hasCurrentNearAssets,
  validateNearTransfer,
} from './nearDirect.service'

import type { StarknetWindowObject } from '@starknet-io/get-starknet'

export const STARKNET_MAINNET = 0x534e5f4d41494en // SN_MAIN, not the synthetic UI chain ID.

export async function fundStarknetTransfer(
  wallet: StarknetWindowObject,
  transfer: NearTransfer,
  beforeSend: () => Promise<void>,
): Promise<string> {
  validateNearTransfer(transfer)
  const { quote } = transfer.response
  const token = starknetDepositToken(transfer)
  const amount = BigInt(quote.amountIn)
  if (amount <= 0n || amount >= 1n << 256n) throw new Error('Amount exceeds Starknet token limits.')
  if (!hasCurrentNearAssets(transfer, await getNearTokens()))
    throw new Error('Asset details changed. Review a new quote.')
  if ((await getNearTransferStatus(transfer)).status !== 'PENDING_DEPOSIT')
    throw new Error('A deposit has already been detected. Do not send again.')
  await assertStarknetFundingWallet(wallet, transfer)
  await beforeSend()
  await assertStarknetFundingWallet(wallet, transfer)
  // The wallet estimates fees, selects its nonce and presents the transfer for approval.
  const result = await wallet
    .request({
      type: 'wallet_addInvokeTransaction',
      params: {
        calls: [
          {
            contract_address: token,
            entry_point: 'transfer',
            calldata: [
              String(quote.depositAddress),
              `0x${(amount % (1n << 128n)).toString(16)}`,
              `0x${(amount >> 128n).toString(16)}`,
            ],
          },
        ],
      },
    })
    .catch(handleStarknetFailure)
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(result.transaction_hash) || BigInt(result.transaction_hash) === 0n)
    throw new Error('Wallet returned no valid transaction hash. Check your wallet before sending again.')
  return `0x${result.transaction_hash.slice(2).padStart(64, '0')}`
}

function starknetDepositToken(transfer: NearTransfer): string {
  const source = transfer.source
  const nativeStrk =
    source.assetId === 'nep141:starknet.omft.near' && source.decimals === 18 && source.symbol === 'STRK'
  const token = source.contractAddress ?? (nativeStrk ? STRK_NATIVE_CURRENCY_ADDRESS : undefined)
  if (source.blockchain !== 'starknet' || transfer.response.quote.depositMemo || !token || !isStarknetAddress(token))
    throw new Error('Unsupported Starknet deposit asset or memo.')
  return token
}

async function assertStarknetFundingWallet(wallet: StarknetWindowObject, transfer: NearTransfer): Promise<void> {
  const [addresses, chainId] = await Promise.all([
    wallet.request({ type: 'wallet_requestAccounts', params: { silent_mode: true } }),
    wallet.request({ type: 'wallet_requestChainId' }),
  ])
  const account = addresses[0]
  // Starknet accepts leading-zero variants; EVM address comparison is unsuitable here.
  if (
    !account ||
    !isStarknetAddress(account) ||
    BigInt(account) !== BigInt(transfer.response.quoteRequest.refundTo) ||
    BigInt(chainId) !== STARKNET_MAINNET
  )
    throw new Error('Connect the refund wallet on Starknet mainnet before sending.')
  if (getNearFundingDeadline(transfer.response) <= Date.now() + 60_000)
    throw new Error('Quote expired. Do not fund it.')
}

function handleStarknetFailure(failure: unknown): never {
  if (
    typeof failure === 'object' &&
    failure !== null &&
    'code' in failure &&
    (failure.code === 113 || failure.code === 4001)
  )
    throw new UserRejectedRequestError(new Error('Starknet transaction rejected in wallet.'))
  throw failure
}
