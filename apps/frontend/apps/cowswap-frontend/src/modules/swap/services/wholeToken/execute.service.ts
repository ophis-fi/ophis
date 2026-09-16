import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider, TransactionReceipt, TransactionResponse, Web3Provider } from '@ethersproject/providers'

import { buildDirectTransaction, DirectQuote } from './router.service'

export async function executeDirectSwap(
  wallet: Web3Provider,
  rpc: JsonRpcProvider,
  quote: DirectQuote,
  isCurrent: () => boolean,
  previousHash?: string,
): Promise<TransactionResponse> {
  if (previousHash && !(await rpc.getTransactionReceipt(previousHash)))
    throw new Error('Previous swap is not confirmed. Check your wallet before retrying.')
  const signer = wallet.getSigner()
  const [chain, account, balance] = await Promise.all([
    wallet.send('eth_chainId', []) as Promise<string>,
    signer.getAddress(),
    rpc.getBalance(quote.account),
  ])
  if (Number(chain) !== 1 || !areAddressesEqual(account, quote.account))
    throw new Error('Wallet changed. Review a new quote.')
  if (BigInt(balance.toString()) < quote.maxTotal) throw new Error('Insufficient ETH including gas.')
  const tx = buildDirectTransaction(quote)
  // A fresh simulation must fit the reviewed gas cap; never silently raise spend limits.
  const gas = await rpc.estimateGas(tx)
  if (BigInt(gas.toString()) > quote.gasLimit) throw new Error('Gas estimate changed. Review a new quote.')
  if (!isCurrent() || Date.now() - quote.quotedAt >= 30000) throw new Error('Quote changed or expired. Review again.')
  return signer.sendTransaction(tx)
}
export async function waitForDirectReceipt(
  tx: TransactionResponse,
  onReplaced?: (hash: string, cancelled: boolean) => void,
): Promise<TransactionReceipt> {
  try {
    return await tx.wait()
  } catch (error) {
    const replacement = error as { code?: string; cancelled?: boolean; receipt?: TransactionReceipt }
    // Ethers marks only a repricing of the same transaction as not cancelled.
    if (replacement?.code === 'TRANSACTION_REPLACED' && replacement.receipt) {
      onReplaced?.(replacement.receipt.transactionHash, replacement.cancelled !== false)
      if (replacement.cancelled === false) return replacement.receipt
    }
    throw error
  }
}
