import type { RobinhoodAssetsResponse, RobinhoodStockAsset } from './types'

const ROBINHOOD_CHAIN_ID = 4663
const CACHE_MS = 5 * 60 * 1_000

let assetsPromise: Promise<RobinhoodStockAsset[]> | undefined
let cacheCreatedAt = 0

export function findRobinhoodStockAsset(
  assets: RobinhoodStockAsset[],
  address: string | undefined,
): RobinhoodStockAsset | undefined {
  if (!address) return undefined
  const normalized = address.toLowerCase()

  return assets.find((asset) =>
    asset.deployments?.some(
      (deployment) =>
        deployment.chainId === ROBINHOOD_CHAIN_ID && deployment.contractAddress.toLowerCase() === normalized,
    ),
  )
}

export function hasTradingRestriction(asset: RobinhoodStockAsset): boolean {
  if (asset.status !== 'ASSET_STATUS_ACTIVE') return true

  const capabilities = asset.tradingCapabilities
  if (!capabilities) return false

  return Object.values(capabilities).some(
    (session) => session && Object.values(session).some((status) => status && status !== 'TRADING_STATUS_TRADABLE'),
  )
}

export function getRobinhoodStockAssets(): Promise<RobinhoodStockAsset[]> {
  if (!assetsPromise || Date.now() - cacheCreatedAt > CACHE_MS) {
    cacheCreatedAt = Date.now()
    // Robinhood's first-party endpoint has no browser CORS headers. The
    // same-origin Pages Function validates and edge-caches its documented
    // payload so metadata remains usable without weakening browser policy.
    assetsPromise = fetch('/api/robinhood/assets')
      .then((response) => {
        if (!response.ok) throw new Error(`Robinhood Stock Token API returned ${response.status}`)
        return response.json() as Promise<RobinhoodAssetsResponse>
      })
      .then((payload) => payload.assets ?? [])
      .catch((error) => {
        assetsPromise = undefined
        throw error
      })
  }

  return assetsPromise
}
