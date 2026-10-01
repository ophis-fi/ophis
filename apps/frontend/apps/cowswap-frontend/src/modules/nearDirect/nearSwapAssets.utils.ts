import { getChainInfo, NATIVE_CURRENCIES, TokenWithLogo } from '@cowprotocol/common-const'
import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { getAddressKey, TargetChainId } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { tokenLogo } from 'ophis/components/intent/tokenAssets'
import { getBridgeTokenLogo } from 'tradingSdk/bridgeTokenLogo.utils'

import { mapChainInfo, TokenPickerOptions } from 'modules/tokensList'

import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { NearToken } from './nearDirect.schemas'

export function nearTokenCurrency(token: NearToken): TokenWithLogo | undefined {
  const chain = DIRECT_NEAR_CHAINS[token.blockchain]
  if (!chain) return undefined
  const native = NATIVE_CURRENCIES[chain.id as TargetChainId]
  if (token.contractAddress) {
    const logo = getBridgeTokenLogo(chain.id, token.contractAddress)
    return new TokenWithLogo(logo, chain.id, token.contractAddress, token.decimals, token.symbol, token.symbol)
  }
  // A second native-looking asset (e.g. BTC(OMNI)) must not alias the native coin.
  if (!native || native.symbol !== token.symbol || native.decimals !== token.decimals) return undefined
  return new TokenWithLogo(
    native.logoURI ?? tokenLogo(token.symbol.toUpperCase()),
    chain.id,
    native.address,
    token.decimals,
    token.symbol,
    token.symbol,
  )
}

function currencyKey(currency: Currency): string {
  const address = currency.isToken ? currency.address : getCurrencyAddress(currency)
  return `${currency.chainId}:${isNonEvmRecipientChain(currency.chainId) ? address : getAddressKey(address)}`
}

export function findNearToken(tokens: NearToken[], currency: Currency | null): NearToken | undefined {
  if (!currency) return undefined
  const key = currencyKey(currency)
  const matches = tokens.filter((token) => {
    const candidate = nearTokenCurrency(token)
    return candidate && currencyKey(candidate) === key
  })
  const token = matches.length === 1 ? matches[0] : undefined
  return token?.decimals === currency.decimals ? token : undefined
}

export function nearTokenPickerOptions(tokens: NearToken[], includeDefaultTokens = false): TokenPickerOptions {
  const candidates = tokens.flatMap((token) => {
    const currency = nearTokenCurrency(token)
    return currency ? [currency] : []
  })
  const counts = new Map<string, number>()
  for (const currency of candidates) {
    const key = currencyKey(currency)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const currencies = candidates.filter((currency) => counts.get(currencyKey(currency)) === 1)
  // Source networks remain discoverable while the live asset catalogue is unavailable.
  const chainIds = includeDefaultTokens
    ? Object.values(DIRECT_NEAR_CHAINS).map(({ id }) => id)
    : [...new Set(currencies.map((token) => token.chainId))]
  const chains = chainIds.flatMap((id) => {
    const info = getChainInfo(id)
    return info ? [mapChainInfo(id as TargetChainId, info)] : []
  })
  return { tokens: currencies, chains, includeDefaultTokens }
}
