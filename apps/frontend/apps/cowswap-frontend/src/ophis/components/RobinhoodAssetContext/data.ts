import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import type { RobinhoodAssetsResponse, RobinhoodStockAsset } from './types'

const ROBINHOOD_CHAIN_ID = 4663

export function findRobinhoodStockAsset(
  assets: RobinhoodStockAsset[],
  address: string | undefined,
): RobinhoodStockAsset | undefined {
  if (!address) return undefined

  return assets.find((asset) =>
    asset.deployments?.some(
      (deployment) =>
        deployment.chainId === ROBINHOOD_CHAIN_ID && areAddressesEqual(deployment.contractAddress, address),
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

export async function fetchRobinhoodStockAssets(): Promise<RobinhoodStockAsset[]> {
  // Robinhood's first-party endpoint has no browser CORS headers. The same-origin
  // Pages Function validates and edge-caches its documented payload.
  const response = await fetch('/api/robinhood/assets')
  if (!response.ok) throw new Error(`Robinhood Stock Token API returned ${response.status}`)
  const payload = (await response.json()) as RobinhoodAssetsResponse
  return payload.assets ?? []
}
