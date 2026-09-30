import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { createPublicClient, custom, encodeFunctionData, erc20Abi, getAddress, type WalletClient } from 'viem'
import { monad, xLayer } from 'viem/chains'

import { NearTransfer } from './nearDirect.schemas'
import {
  getNearFundingDeadline,
  getNearTokens,
  getNearTransferStatus,
  hasCurrentNearAssets,
  validateNearTransfer,
} from './nearDirect.service'

export async function fundNearTransfer(
  wallet: WalletClient,
  transfer: NearTransfer,
  beforeSend: (nonce: number) => void | Promise<void>,
): Promise<string> {
  const chain = await getFundingChain(transfer)
  const account = getAddress(transfer.response.quoteRequest.refundTo)
  const deposit = getAddress(String(transfer.response.quote.depositAddress))
  const amount = BigInt(transfer.response.quote.amountIn)
  const client = createPublicClient({ chain, transport: custom({ request: wallet.request }, { retryCount: 0 }) })
  const token = transfer.source.contractAddress ? getAddress(transfer.source.contractAddress) : undefined
  const to = token ?? deposit
  const data = token
    ? encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, amount] })
    : undefined
  const value = token ? 0n : amount
  const assertWallet = async (): Promise<void> => {
    const [id, addresses] = await Promise.all([wallet.getChainId(), wallet.getAddresses()])
    if (id !== chain.id || !addresses[0] || !areAddressesEqual(addresses[0], account)) {
      throw new Error(`Connect the refund wallet on ${chain.name} before sending.`)
    }
  }
  await assertWallet()
  const [balance, gasEstimate, gasPrice, nonce] = await Promise.all([
    client.getBalance({ address: account }),
    client.estimateGas({ account, to, data, value }),
    client.getGasPrice(),
    client.getTransactionCount({ address: account, blockTag: 'pending' }),
  ])
  const gas = (gasEstimate * 12n) / 10n
  if (balance < value + gas * gasPrice) throw new Error('Leave enough native currency for the network fee.')
  if (token) {
    const [tokenBalance, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ])
    if (tokenBalance < amount || decimals !== transfer.source.decimals)
      throw new Error('Insufficient token balance or token decimals changed.')
  }
  await assertWallet()
  if (getNearFundingDeadline(transfer.response) <= Date.now() + 60_000)
    throw new Error('Quote expired. Do not fund it.')
  await beforeSend(nonce)
  // Transfer only: the wallet never grants an allowance to a NEAR deposit address.
  return wallet.sendTransaction({ account, chain, to, data, value, gas, gasPrice, nonce })
}

async function getFundingChain(transfer: NearTransfer): Promise<typeof monad | typeof xLayer> {
  validateNearTransfer(transfer)
  const chain =
    transfer.source.blockchain === 'monad' ? monad : transfer.source.blockchain === 'xlayer' ? xLayer : undefined
  if (!chain || transfer.response.quote.depositMemo)
    throw new Error('Use the external wallet deposit instructions for this route.')
  if (!hasCurrentNearAssets(transfer, await getNearTokens()))
    throw new Error('Asset details changed. Review a new quote.')
  if ((await getNearTransferStatus(transfer)).status !== 'PENDING_DEPOSIT')
    throw new Error('A deposit has already been detected. Do not send again.')
  return chain
}
