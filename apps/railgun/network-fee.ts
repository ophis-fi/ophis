import { Interface, isHexString, type JsonRpcProvider, type TransactionReceipt } from 'ethers'

const BASE_GAS_ORACLE = '0x420000000000000000000000000000000000000F'
const BASE_GAS_ABI = new Interface(['function getOperatorFee(uint256 gasUsed) view returns (uint256)'])

/** Callers verify chain and finalized canonical receipt before accepting a charge. */
export async function receiptNetworkCost(provider: Partial<Pick<JsonRpcProvider, 'send'>>, receipt: TransactionReceipt,
  chainId: number): Promise<bigint> {
  if ((receipt.status !== 0 && receipt.status !== 1) || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n ||
    typeof receipt.gasPrice !== 'bigint' || receipt.gasPrice < 0n) throw new Error('Invalid receipt gas evidence.')
  let networkCost = receipt.gasUsed * receipt.gasPrice
  if (chainId === 8453) {
    if (!provider.send) throw new Error('Base settlement requires complete historical fee evidence.')
    // Ethers omits L1 fees; bind the raw receipt and historical operator fee to the same canonical block.
    const [raw, operatorFee] = await Promise.all([
      provider.send('eth_getTransactionReceipt', [receipt.hash]),
      provider.send('eth_call', [{ to: BASE_GAS_ORACLE, data: BASE_GAS_ABI.encodeFunctionData('getOperatorFee', [receipt.gasUsed]) },
        { blockHash: receipt.blockHash, requireCanonical: true }]),
    ])
    const quantity = (value: unknown): bigint => {
      if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value))
        throw new Error('Base receipt fee evidence is incomplete or invalid.')
      return BigInt(value)
    }
    if (!raw || raw.transactionHash !== receipt.hash || raw.blockHash !== receipt.blockHash ||
      quantity(raw.blockNumber) !== BigInt(receipt.blockNumber) || quantity(raw.status) !== BigInt(receipt.status) ||
      quantity(raw.gasUsed) !== receipt.gasUsed || quantity(raw.effectiveGasPrice) !== receipt.gasPrice ||
      typeof operatorFee !== 'string' || !isHexString(operatorFee, 32))
      throw new Error('Base fee evidence does not match its finalized receipt.')
    networkCost += quantity(raw.l1Fee) + BigInt(operatorFee)
  }
  if (networkCost < 0n || networkCost >= 2n ** 256n) throw new Error('Finalized network cost exceeds its permitted range.')
  return networkCost
}
