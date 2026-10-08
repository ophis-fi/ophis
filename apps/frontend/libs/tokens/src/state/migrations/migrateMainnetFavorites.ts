import { DAI, EURE_MAINNET, WBTC, WETH_MAINNET } from '@cowprotocol/common-const'
import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'

import { DEFAULT_FAVORITE_TOKENS } from '../../const/defaultFavoriteTokens'

// TODO: remove after 2027-10-08, once v5 browser favorites have aged out.
export function migrateMainnetFavorites(): void {
  try {
    if (localStorage.getItem('favoriteTokensAtom:v6') !== null) return
    const raw = localStorage.getItem('favoriteTokensAtom:v5')
    if (!raw) return
    const stored: unknown = JSON.parse(raw)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    const chain = Reflect.get(stored, SupportedChainId.MAINNET)
    if (chain !== undefined) {
      if (!chain || Object.getPrototypeOf(chain) !== Object.prototype) return
      const retired = new Set([DAI, WBTC, WETH_MAINNET, EURE_MAINNET].map((token) => getAddressKey(token.address)))
      const defaults = DEFAULT_FAVORITE_TOKENS[SupportedChainId.MAINNET]
      const custom = Object.fromEntries(
        Object.entries(chain).filter(
          ([address]) => !retired.has(getAddressKey(address)) && !defaults[getAddressKey(address)],
        ),
      )
      Reflect.set(stored, SupportedChainId.MAINNET, { ...defaults, ...custom })
    }
    localStorage.setItem('favoriteTokensAtom:v6', JSON.stringify(stored))
  } catch {
    // Keep the old state if storage is unavailable or malformed.
  }
}
