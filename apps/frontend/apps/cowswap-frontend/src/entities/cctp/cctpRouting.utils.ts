import { TokenWithLogo } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'
import { BuyTokensParams } from '@cowprotocol/sdk-bridging'

import { CCTP_ENABLED } from 'common/constants/featureFlags'

import { CCTP_ASSETS, cctpAsset, cctpToken, supportsCctpAsset, type CctpAsset } from './cctpAssets.const'

export function hasCctpRoute(source: number, destination: number): boolean {
  return (
    CCTP_ENABLED &&
    source !== destination &&
    CCTP_ASSETS.some((asset) => supportsCctpAsset(source, asset) && supportsCctpAsset(destination, asset))
  )
}

export function cctpRouteAsset(
  input: Currency | null | undefined,
  output: Currency | null | undefined,
): CctpAsset | undefined {
  if (!input?.isToken || !output?.isToken || !hasCctpRoute(input.chainId, output.chainId)) return undefined
  return CCTP_ASSETS.find(
    (asset) =>
      supportsCctpAsset(input.chainId, asset) &&
      supportsCctpAsset(output.chainId, asset) &&
      input.decimals === cctpAsset(asset).decimals &&
      output.decimals === cctpAsset(asset).decimals &&
      areAddressesEqual(input.address, cctpToken(input.chainId, asset)) &&
      areAddressesEqual(output.address, cctpToken(output.chainId, asset)),
  )
}

export function cctpBuyTokens(params: BuyTokensParams | undefined): TokenWithLogo[] {
  if (!params) return []
  const { sellChainId, buyChainId, sellTokenAddress } = params
  if (!sellChainId || !hasCctpRoute(sellChainId, buyChainId)) return []
  return CCTP_ASSETS.filter(
    (asset) =>
      supportsCctpAsset(sellChainId, asset) &&
      supportsCctpAsset(buyChainId, asset) &&
      (!sellTokenAddress || areAddressesEqual(sellTokenAddress, cctpToken(sellChainId, asset))),
  ).map((asset) =>
    TokenWithLogo.fromToken({
      chainId: buyChainId,
      address: cctpToken(buyChainId, asset),
      decimals: cctpAsset(asset).decimals,
      symbol: asset,
      name: asset,
    }),
  )
}
