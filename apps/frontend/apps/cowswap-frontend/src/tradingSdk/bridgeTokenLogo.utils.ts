import { NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { getAddressKey, TargetChainId } from '@cowprotocol/cow-sdk'

import { tokenLogo } from 'ophis/components/intent/tokenAssets'

import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

export function getBridgeTokenLogo(chainId: number, address: string, symbol: string): string | undefined {
  const native = NATIVE_CURRENCIES[chainId as TargetChainId]
  const isNative =
    native &&
    (isNonEvmRecipientChain(chainId)
      ? address === native.address
      : getAddressKey(address) === getAddressKey(native.address))
  return (isNative && native.logoURI) || tokenLogo(symbol.toUpperCase())
}
