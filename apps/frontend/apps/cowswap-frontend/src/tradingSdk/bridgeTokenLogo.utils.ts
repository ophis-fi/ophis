import { NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey, TargetChainId } from '@cowprotocol/cow-sdk'

import { tokenLogo } from 'ophis/components/intent/tokenAssets'

import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { BRIDGE_TOKEN_LOGOS } from './bridgeTokenLogos.const'

export function getBridgeTokenLogo(chainId: number, address: string): string | undefined {
  const native = NATIVE_CURRENCIES[chainId as TargetChainId]
  const isNative =
    native &&
    (isNonEvmRecipientChain(chainId) ? address === native.address : areAddressesEqual(address, native.address))
  if (isNative) return native.logoURI ?? tokenLogo(native.symbol?.toUpperCase() ?? '')
  const addressKey = isNonEvmRecipientChain(chainId) ? address : getAddressKey(address)
  return BRIDGE_TOKEN_LOGOS[`${chainId}:${addressKey}`]
}
