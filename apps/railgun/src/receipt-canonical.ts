import { isHexString, toQuantity, ZeroHash, type JsonRpcProvider, type TransactionReceipt } from 'ethers'

/** Terminal rechecks must bypass ethers' short getBlock cache. Ordinary reads retain their cache. */
export async function readUncachedBlockHeader(provider: Pick<JsonRpcProvider, 'send'>, block: number | 'finalized' | 'latest'):
  Promise<{ number: number; hash: string } | null> {
  const value = await provider.send('eth_getBlockByNumber', [typeof block === 'number' ? toQuantity(block) : block, false]).catch(() => {
    throw new Error('Transaction confirmation evidence is unavailable. Keep the saved private transaction.')
  })
  if (value === null) return null
  const number = typeof value?.number === 'string' && /^0x[0-9a-f]{1,14}$/i.test(value.number)
    ? Number(BigInt(value.number)) : NaN
  if (!Number.isSafeInteger(number) || number < 0 || !isHexString(value?.hash, 32) || value.hash === ZeroHash)
    throw new Error('Transaction confirmation evidence is unavailable. Keep the saved private transaction.')
  return { number, hash: value.hash }
}

/** A cached receipt's confirmation count measures height, not continued inclusion. */
export async function assertCanonicalReceipt(
  provider: Pick<JsonRpcProvider, 'send'>,
  receipt: Pick<TransactionReceipt, 'blockNumber' | 'blockHash'>,
): Promise<void> {
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
    !isHexString(receipt.blockHash, 32) || receipt.blockHash === ZeroHash)
    throw new Error('Transaction confirmation evidence is unavailable. Keep the saved private transaction.')
  const canonical = await readUncachedBlockHeader(provider, receipt.blockNumber).catch(() => {
    throw new Error('Transaction confirmation evidence is unavailable. Keep the saved private transaction.')
  })
  if (!canonical || canonical.number !== receipt.blockNumber ||
    canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase())
    throw new Error('Transaction history changed. Keep the saved private transaction and check its receipt again.')
}
