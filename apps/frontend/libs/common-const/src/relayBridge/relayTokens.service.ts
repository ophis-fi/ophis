import { areAddressesEqual, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'

import { relayCurrency } from './relay.constants'
import { RelayChain, RelayCurrency } from './relay.types'

import { NATIVE_CURRENCIES, WRAPPED_NATIVE_CURRENCIES } from '../nativeAndWrappedTokens'

const ASSETS = new Set(['eth', 'weth', 'usdc', 'usdt', 'usdg', 'dai'])
const assetId = (id: string): string => (id === 'weth' ? 'eth' : id)

export function relayTokens(
  chain: RelayChain,
  trusted: TokenInfo[],
  source = false,
): (TokenInfo & { asset: string })[] {
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
