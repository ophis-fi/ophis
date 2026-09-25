import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'

import { isAddress, type Address } from 'viem'

import { CCTP_NETWORKS, cctpNetwork } from './cctp.const'
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
  const token = source === requestedSource ? resolveBridgeToken(params.get('token'), source) : undefined
  const asset =
    !token && isCctpAsset(requestedAsset)
      ? requestedAsset
      : (CCTP_ASSETS.find(
          (item) => supportsCctpAsset(source, item) && areAddressesEqual(cctpToken(source, item), token),
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
  return supportsCctpAsset(source, asset) && areAddressesEqual(token, cctpToken(source, asset)) ? undefined : token
}

function resolveBridgeToken(token: string | null, source: number): string | undefined {
  if (!token) return undefined
  if (source === 5042 && areAddressesEqual(token, NATIVE_CURRENCY_ADDRESS)) return cctpToken(source, 'USDC')
  if (isAddress(token, { strict: false })) return getAddressKey(token)
  if (isCctpAsset(token) && supportsCctpAsset(source, token)) return cctpToken(source, token)
  if (token === cctpNetwork(source).chain.nativeCurrency.symbol) return NATIVE_CURRENCY_ADDRESS
  return token
}
