import { NATIVE_CURRENCIES, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'

import { tokenLogo } from 'ophis/components/intent/tokenAssets'

import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { BRIDGE_TOKEN_LOGOS } from './bridgeTokenLogos.const'

export function getBridgeTokenLogo(chainId: number, address: string): string | undefined {
  const canonical = [
    NATIVE_CURRENCIES[chainId as TargetChainId],
    WRAPPED_NATIVE_CURRENCIES[chainId as SupportedChainId],
  ].find(
    (currency) =>
      currency &&
      (isNonEvmRecipientChain(chainId) ? address === currency.address : areAddressesEqual(address, currency.address)),
  )
  if (canonical) return canonical.logoURI ?? tokenLogo(canonical.symbol?.toUpperCase() ?? '')
  const addressKey = isNonEvmRecipientChain(chainId) ? address : getAddressKey(address)
  return BRIDGE_TOKEN_LOGOS[`${chainId}:${addressKey}`]
}
