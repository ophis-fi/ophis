import { areAddressesEqual, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'

import { relayCurrency } from './relay.constants'
import { RelayChain, RelayCurrency } from './relay.types'

import { NATIVE_CURRENCIES, WRAPPED_NATIVE_CURRENCIES } from '../nativeAndWrappedTokens'
import { USDC_BASE, USDT_PLASMA } from '../tokens'

const ASSETS = new Set(['eth', 'weth', 'usdc', 'usdt', 'usdg', 'dai'])
const assetId = (id: string): string => (id === 'weth' ? 'eth' : id)

type RelayToken = TokenInfo & { asset: string }

export function relayTokensMatch(source: RelayToken, destination: RelayToken): boolean {
  return (
    source.asset === destination.asset ||
    (source.chainId === USDT_PLASMA.chainId &&
      destination.chainId === USDC_BASE.chainId &&
      areAddressesEqual(source.address, USDT_PLASMA.address) &&
      areAddressesEqual(destination.address, USDC_BASE.address))
  )
}

export function relayTokens(chain: RelayChain, trusted: TokenInfo[], source = false): RelayToken[] {
  const currencies: RelayCurrency[] = [...chain.erc20Currencies, ...(source ? [] : [chain.currency])]
  const known = [
    NATIVE_CURRENCIES[chain.id as SupportedChainId],
    WRAPPED_NATIVE_CURRENCIES[chain.id as SupportedChainId],
    ...trusted,
  ]
  return currencies.flatMap((currency) => {
    if (!currency.supportsBridging || !ASSETS.has(currency.id)) return []
    const token = known.find(
      (item) =>
        item?.chainId === chain.id &&
        areAddressesEqual(relayCurrency(item.address), currency.address) &&
        item.decimals === currency.decimals,
    )
    return token
      ? [
          {
            address: token.address,
            chainId: token.chainId,
            decimals: token.decimals,
            symbol: token.symbol,
            name: token.name,
            asset: assetId(currency.id),
          },
        ]
      : []
  })
}
