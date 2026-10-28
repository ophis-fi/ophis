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
// Ethereum V2 proxy, verified against the pinned Railgun SDK in the gateway tests.
export const RAILGUN_PROXY = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9'
export const RAILGUN_PROXIES: Readonly<Record<number, string>> = {
  1: RAILGUN_PROXY,
  42161: '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9',
  137: '0x19b620929f97b7b990801496c3b361ca5def8c71',
  56: '0x590162bf4b50f6576a459b75309ee21d92178a10',
}
