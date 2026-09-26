import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { cctpToken } from './cctpAssets.const'

export const WBTC_ETHEREUM = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'

export function isBtcCctpSource(source: number, destination: number, address: string | undefined): boolean {
  return source === 1 && destination === ARC_CHAIN_ID && areAddressesEqual(address, WBTC_ETHEREUM)
}

export function isBtcCctpSwap(input: Currency | null | undefined, output: Currency | null | undefined): boolean {
  return !!(
    input?.isToken &&
    output?.isToken &&
    input.decimals === 8 &&
    output.decimals === 8 &&
    isBtcCctpSource(input.chainId, output.chainId, input.address) &&
    areAddressesEqual(output.address, cctpToken(ARC_CHAIN_ID, 'cirBTC'))
  )
}
