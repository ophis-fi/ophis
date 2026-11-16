import { isHexString, type TransactionReceipt } from 'ethers'
import type { WalletSession } from './wallet'

/** Keep signed private-operation journals until Base can no longer reorg their execution nonce. */
export async function assertBaseReceiptFinality(session: WalletSession, receipt: TransactionReceipt): Promise<void> {
  if ((await session.provider.getNetwork()).chainId !== 8453n || receipt.status !== 1 ||
    !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
    !isHexString(receipt.hash, 32) || !isHexString(receipt.blockHash, 32))
    throw new Error('Base finality evidence is unavailable. Keep the saved private transaction.')
  const [finalized, canonical] = await Promise.all([
    session.provider.getBlock('finalized'), session.provider.getBlock(receipt.blockNumber),
  ])
  if (!canonical || canonical.number !== receipt.blockNumber || canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase())
    throw new Error('Base transaction history changed. Keep the saved private transaction and check its receipt again.')
  if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < 0 || !isHexString(finalized.hash, 32))
    throw new Error('Base finality evidence is unavailable. Keep the saved private transaction.')
  if (finalized.number < receipt.blockNumber)
    throw new Error('Transaction included; awaiting Base finality. Private balances may be synchronized, but keep the saved transaction and check again.')
  const pinned = await session.provider.getBlock(finalized.number)
  if (!pinned || pinned.number !== finalized.number || pinned.hash !== finalized.hash)
    throw new Error('Base finality history changed. Keep the saved private transaction and check again.')
}
