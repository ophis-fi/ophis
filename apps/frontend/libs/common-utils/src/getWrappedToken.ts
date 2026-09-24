import { ARC_CHAIN_ID, TokenWithLogo, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { getIsNativeToken } from './getIsNativeToken'

export function getWrappedToken(currency: Currency): TokenWithLogo {
  return getIsNativeToken(currency) && currency.chainId !== ARC_CHAIN_ID
    ? WRAPPED_NATIVE_CURRENCIES[currency.chainId as SupportedChainId]
    : (currency as TokenWithLogo)
}
