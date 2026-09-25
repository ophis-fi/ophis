import { isAddress, type Address } from 'viem'

import { CCTP_NETWORKS } from './cctp.const'
import {
  CCTP_ASSETS,
  cctpAssetRoute,
  cctpToken,
  isCctpAsset,
  supportsCctpAsset,
  type CctpAsset,
} from './cctpAssets.const'

export function cctpInitialSelection(
  search: string,
  walletChain: number,
): { asset: CctpAsset; source: number; destination: number; swapFirstToken?: Address } {
  const params = new URLSearchParams(search)
  const requestedSource = Number(params.get('source') || walletChain)
  const source = CCTP_NETWORKS.some(({ chain }) => chain.id === requestedSource) ? requestedSource : 8453
  const requestedAsset = params.get('asset')
  const token = params.get('token')?.toLowerCase()
  const asset =
    !token && isCctpAsset(requestedAsset)
      ? requestedAsset
      : (CCTP_ASSETS.find(
          (item) => supportsCctpAsset(source, item) && cctpToken(source, item).toLowerCase() === token,
        ) ?? 'USDC')
  const swapFirstToken = unsupportedBridgeToken(token, source, asset)
  return {
    asset,
    ...cctpAssetRoute(asset, source, source === 5042 ? 8453 : 5042),
    ...(swapFirstToken ? { swapFirstToken } : {}),
  }
}

function unsupportedBridgeToken(token: string | undefined, source: number, asset: CctpAsset): Address | undefined {
  if (!token || !isAddress(token)) return undefined
  return supportsCctpAsset(source, asset) && token === cctpToken(source, asset).toLowerCase() ? undefined : token
}
