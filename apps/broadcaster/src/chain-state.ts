import type { Block, JsonRpcProvider } from 'ethers'
import { CHAIN_ID } from './config'

export async function readChainState(provider: Pick<JsonRpcProvider, 'getBlock' | 'getFeeData'>): Promise<{
  block: Block; settled: number; baseFee: bigint; minimumGasPrice: bigint
}> {
  const block = await provider.getBlock('latest')
  if (!block || !Number.isSafeInteger(block.number) || block.number < 0 ||
    !Number.isSafeInteger(block.timestamp) || block.timestamp < 0 ||
    !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash) || /^0x0{64}$/i.test(block.hash) ||
    Math.abs(Date.now() / 1000 - block.timestamp) > 45)
    throw new Error('The selected chain read node is stale or returned a malformed head.')
  const baseFee = block.baseFeePerGas ?? (CHAIN_ID === 56 ? 0n : undefined)
  if (typeof baseFee !== 'bigint' || baseFee < 0n || (CHAIN_ID !== 56 && baseFee === 0n))
    throw new Error('The selected chain base fee is unavailable or invalid.')
  let settled = Math.max(0, block.number - 1)
  if (CHAIN_ID !== 1) {
    const finalized = await provider.getBlock('finalized')
    if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < 0 || finalized.number > block.number ||
      !finalized.hash || !/^0x[0-9a-f]{64}$/i.test(finalized.hash) || /^0x0{64}$/i.test(finalized.hash) ||
      (finalized.number === block.number && finalized.hash.toLowerCase() !== block.hash.toLowerCase()))
      throw new Error('The selected chain finalized block is unavailable or invalid.')
    settled = finalized.number
  }
  let minimumGasPrice = baseFee + 1n
  if (CHAIN_ID === 56 || CHAIN_ID === 137) {
    const fee = await provider.getFeeData()
    const suggested = CHAIN_ID === 56 ? fee?.gasPrice : fee?.maxPriorityFeePerGas
    if (typeof suggested !== 'bigint' || suggested <= 0n)
      throw new Error('The selected chain minimum gas price is unavailable or invalid.')
    minimumGasPrice = CHAIN_ID === 56 ? suggested : baseFee + suggested
  }
  if (typeof minimumGasPrice !== 'bigint' || minimumGasPrice <= 0n)
    throw new Error('The selected chain minimum gas price is unavailable or invalid.')
  if (minimumGasPrice < baseFee + 1n) minimumGasPrice = baseFee + 1n
  return { block, settled, baseFee, minimumGasPrice }
}
