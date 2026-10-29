export const RPC_BATCH_SIZE = 20

const ZAN_NETWORK_PATHS: Readonly<Record<number, string>> = {
  42161: 'arb/one',
  137: 'polygon/mainnet',
  56: 'bsc/mainnet',
}

export function zanRpcUrl(chainId: number, key?: string): string | undefined {
  const path = ZAN_NETWORK_PATHS[chainId]
  return path && key ? `https://api.zan.top/node/v1/${path}/${encodeURIComponent(key)}` : undefined
}

const VALIDATION_CLOUD_HOSTS: Readonly<Record<number, string>> = {
  42161: 'mainnet.arbitrum.validationcloud.io',
  137: 'mainnet.polygon.validationcloud.io',
  56: 'mainnet.bsc.validationcloud.io',
}

export function isValidationCloudUrl(chainId: number, value: string): boolean {
  const url = new URL(value)
  return url.protocol === 'https:' && url.hostname === VALIDATION_CLOUD_HOSTS[chainId]
    && !url.port && !url.username && !url.password && !url.search && !url.hash
    && /^\/v1\/[A-Za-z0-9_-]+$/.test(url.pathname)
}

const ALCHEMY_HOSTS: Readonly<Record<number, string>> = {
  42161: 'arb-mainnet.g.alchemy.com',
  137: 'polygon-mainnet.g.alchemy.com',
  56: 'bnb-mainnet.g.alchemy.com',
}

export function isAlchemyUrl(chainId: number, value: string): boolean {
  const url = new URL(value)
  return url.protocol === 'https:' && url.hostname === ALCHEMY_HOSTS[chainId]
    && !url.port && !url.username && !url.password && !url.search && !url.hash
    && /^\/v2\/[A-Za-z0-9_-]+$/.test(url.pathname)
}

// https://www.alchemy.com/docs/reference/compute-unit-costs, checked 2026-10-29.
// Free-tier traces are unavailable; log scans use the existing Validation Cloud allowance.
const ALCHEMY_CU: Readonly<Partial<Record<string, number>>> = {
  eth_chainId: 0, net_version: 0, web3_clientVersion: 20, eth_blockNumber: 10,
  eth_getBlockByNumber: 20, eth_getBlockByHash: 20, eth_getBalance: 20, eth_getCode: 20,
  eth_getStorageAt: 20, eth_getTransactionCount: 20, eth_getTransactionByHash: 20,
  eth_getTransactionReceipt: 20, eth_call: 26, eth_estimateGas: 20, eth_gasPrice: 20,
  eth_maxPriorityFeePerGas: 10, eth_feeHistory: 10, eth_sendRawTransaction: 40,
}
export function alchemyCU(method: string): number | undefined {
  return Object.hasOwn(ALCHEMY_CU, method) ? ALCHEMY_CU[method] : undefined
}
export function alchemyThroughputCU(method: string): number | undefined {
  if (method === 'eth_chainId' || method === 'net_version') return 5
  if (method === 'eth_sendRawTransaction') return 50
  return alchemyCU(method)
}

// Published EVM costs: undocumented methods stay off this metered provider.
const VALIDATION_CLOUD_CU: Readonly<Partial<Record<string, number>>> = {
  eth_chainId: 10, net_version: 10, web3_clientVersion: 40, eth_blockNumber: 20,
  eth_getBlockByNumber: 40, eth_getBlockByHash: 40, eth_getBalance: 40, eth_getCode: 40,
  eth_getStorageAt: 40, eth_getLogs: 80, eth_getTransactionCount: 40,
  eth_getTransactionByHash: 40, eth_getTransactionReceipt: 40,
  // Some chains omit priority-fee pricing; reserve 80 rather than Arbitrum's published 20.
  eth_call: 40, eth_estimateGas: 40, eth_gasPrice: 40, eth_maxPriorityFeePerGas: 80,
  eth_sendRawTransaction: 80, debug_traceCall: 80,
}
export function validationCloudCU(method: string): number | undefined {
  return Object.hasOwn(VALIDATION_CLOUD_CU, method) ? VALIDATION_CLOUD_CU[method] : undefined
}
// Ethereum V2 proxy, verified against the pinned Railgun SDK in the gateway tests.
export const RAILGUN_PROXY = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9'
export const RAILGUN_PROXIES: Readonly<Record<number, string>> = {
  1: RAILGUN_PROXY,
  42161: '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9',
  137: '0x19b620929f97b7b990801496c3b361ca5def8c71',
  56: '0x590162bf4b50f6576a459b75309ee21d92178a10',
}
