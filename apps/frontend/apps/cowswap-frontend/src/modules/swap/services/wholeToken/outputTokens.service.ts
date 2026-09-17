import { areAddressesEqual, EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'

import { WXDAI } from './gnosis.service'
import { USDC, WETH } from './router.service'

// Execution allowlist; tests pin these addresses to the app's token metadata.
export const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
export const GNOSIS_USDC = '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83'
export const GNOSIS_USDT = '0x4ECaBa5870353805a9F068101A40E0f32ed605C6'
export const GNOSIS_WETH = '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1'

export function isSupportedMpsOutput(chainId: number, token: string): boolean {
  const tokens =
    chainId === 100
      ? [EVM_NATIVE_CURRENCY_ADDRESS, WXDAI, GNOSIS_WETH, GNOSIS_USDC, GNOSIS_USDT]
      : chainId === 1
        ? [EVM_NATIVE_CURRENCY_ADDRESS, WETH, USDC, USDT]
        : []
  return tokens.some((address) => areAddressesEqual(address, token))
}
