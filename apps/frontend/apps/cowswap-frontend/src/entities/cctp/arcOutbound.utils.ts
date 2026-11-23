import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, TokenWithLogo, USDC, isCircleToken } from '@cowprotocol/common-const'
import { areAddressesEqual, SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'
import { BuyTokensParams } from '@cowprotocol/sdk-bridging'

import { CCTP_ENABLED } from 'common/constants/featureFlags'

import { hasCctpRoute } from './cctpRouting.utils'

// Direct wallet deposits share the standalone bridge surface. Each provider still has to quote the pair.
export function arcOutboundToken(source?: number, destination?: number): TokenWithLogo | undefined {
  if (!CCTP_ENABLED || source !== ARC_CHAIN_ID || !destination || source === destination) return undefined
  const token = USDC[destination as SupportedChainId]
  return token?.symbol === 'USDC' && token.decimals === 6 && isCircleToken(token) ? token : undefined
}

export function hasWalletBridgeRoute(source: number, destination: number): boolean {
  return hasCctpRoute(source, destination) || !!arcOutboundToken(source, destination)
}

export function arcOutboundBuyTokens(params?: BuyTokensParams): TokenWithLogo[] {
  const token = arcOutboundToken(params?.sellChainId, params?.buyChainId)
  return token && (!params?.sellTokenAddress || areAddressesEqual(params.sellTokenAddress, ARC_USDC_ADDRESS))
    ? [token]
    : []
}

export function isArcOutboundPair(input?: Currency | null, output?: Currency | null): boolean {
  if (!input?.isToken || !output?.isToken) return false
  const token = arcOutboundToken(input.chainId, output.chainId)
  return !!(
    token &&
    input.decimals === 6 &&
    output.decimals === 6 &&
    areAddressesEqual(input.address, ARC_USDC_ADDRESS) &&
    areAddressesEqual(output.address, token.address)
  )
}
