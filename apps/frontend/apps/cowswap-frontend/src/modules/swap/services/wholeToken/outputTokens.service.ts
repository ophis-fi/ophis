import {
  BRIDGED_WETH_GNOSIS_CHAIN,
  USDC_GNOSIS_CHAIN,
  USDT as USDT_TOKEN,
  USDT_GNOSIS_CHAIN,
} from '@cowprotocol/common-const'
import { areAddressesEqual, EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'

import { WXDAI } from './gnosis.service'
import { USDC, WETH } from './router.service'

export const USDT = USDT_TOKEN.address
export const GNOSIS_USDC = USDC_GNOSIS_CHAIN.address
export const GNOSIS_USDT = USDT_GNOSIS_CHAIN.address
export const GNOSIS_WETH = BRIDGED_WETH_GNOSIS_CHAIN.address

export function isSupportedMpsOutput(chainId: number, token: string): boolean {
  const tokens =
    chainId === 100
      ? [EVM_NATIVE_CURRENCY_ADDRESS, WXDAI, GNOSIS_WETH, GNOSIS_USDC, GNOSIS_USDT]
      : chainId === 1
        ? [EVM_NATIVE_CURRENCY_ADDRESS, WETH, USDC, USDT]
        : []
  return tokens.some((address) => areAddressesEqual(address, token))
}
