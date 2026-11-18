import type { Hex } from 'viem'

export const OPHIS_BASE_BUILDER_CODE = 'bc_8j4gt5x6'
export const OPHIS_BASE_DATA_SUFFIX = '0x62635f386a3467743578360b0080218021802180218021802180218021'

const BASE_CHAIN_ID = 8453
const ERC8021_MARKER = '80218021802180218021802180218021'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function withBatchAttribution(params: unknown[], tx: Record<string, unknown>): unknown[] {
  const capabilities = tx.capabilities
  if (capabilities !== undefined && !isRecord(capabilities)) return params
  if (capabilities && 'dataSuffix' in capabilities) return params
  return [
    { ...tx, capabilities: { ...capabilities, dataSuffix: { value: OPHIS_BASE_DATA_SUFFIX, optional: true } } },
    ...params.slice(1),
  ]
}

export function appendOphisBaseBuilderCode(data: Hex, chainId: number): Hex {
  if (chainId !== BASE_CHAIN_ID) return data
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw new Error('Invalid transaction calldata')
  // Preserve receive/fallback calls and attribution already supplied by another builder or wallet.
  if (data.length < 10 || data.toLowerCase().endsWith(ERC8021_MARKER)) return data
  return `0x${data.slice(2)}${OPHIS_BASE_DATA_SUFFIX.slice(2)}`
}

export function withOphisBaseTransactionParams(method: string, params: unknown[], chainId: number): unknown[] {
  if (
    chainId !== BASE_CHAIN_ID ||
    !['eth_estimateGas', 'eth_sendTransaction', 'wallet_sendTransaction', 'wallet_sendCalls'].includes(method)
  )
    return params
  const tx = params[0]
  if (!isRecord(tx)) return params
  if (tx.chainId !== undefined && Number(tx.chainId) !== chainId) {
    throw new Error('Transaction network does not match the connected wallet')
  }
  if (method === 'wallet_sendCalls') return withBatchAttribution(params, tx)
  // A missing recipient denotes contract creation; its initcode must remain byte-for-byte intact.
  if (typeof tx.to !== 'string' || typeof tx.data !== 'string') return params
  const data = appendOphisBaseBuilderCode(tx.data as Hex, chainId)
  return data === tx.data ? params : [{ ...tx, data }, ...params.slice(1)]
}

export async function assertAttributedTransactionGas(
  params: unknown[],
  send: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<void> {
  // Some legacy callers fall back to a fixed gas limit after estimation fails.
  const estimate = await send('eth_estimateGas', params)
  if (typeof estimate !== 'string' || !/^0x[0-9a-f]+$/i.test(estimate)) throw new Error('Invalid gas estimate')
  const tx = params[0] as { gas?: string }
  if (tx.gas !== undefined && BigInt(estimate) > BigInt(tx.gas)) {
    throw new Error('Gas estimate exceeds the reviewed limit. Please retry.')
  }
}
