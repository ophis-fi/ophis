import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { COW_TOKEN_TO_CHAIN, TokenWithLogo, USDC_GNOSIS_CHAIN, USDCe_GNOSIS_CHAIN } from '@cowprotocol/common-const'
import { getJotaiMergerStorage } from '@cowprotocol/core'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { DEFAULT_FAVORITE_TOKENS } from '../../const/defaultFavoriteTokens'
import { TokensMap } from '../../types'
import { environmentAtom } from '../environmentAtom'

type FavoriteTokens = Record<SupportedChainId, TokensMap>

const EMPTY_FAVORITE_TOKENS: TokenWithLogo[] = []

// v3 (2026-06-03): dropped the CoW governance token from the default favorites.
// getJotaiMergerStorage is additive (it never DELETES a stored entry), so a key
// bump is the only way to drop COW for an existing user. But a naive bump would
// also discard every token the user added under v2. migrateFavoriteTokensAtomV2toV3
// (below) carries the v2 selection forward MINUS the COW token, so a personalized
// favorites list survives the upgrade instead of being reset to the defaults.
export const favoriteTokensAtom = atomWithStorage<FavoriteTokens>(
  'favoriteTokensAtom:v3',
  DEFAULT_FAVORITE_TOKENS,
  getJotaiMergerStorage(),
)

export const favoriteTokensListAtom = atom((get) => {
  const { chainId } = get(environmentAtom)
  const favoriteTokensState = get(favoriteTokensAtom)
  const state = favoriteTokensState[chainId]

  if (!state) return EMPTY_FAVORITE_TOKENS

  return Object.values(state).map((token) => TokenWithLogo.fromToken(token, token.logoURI))
})

export const resetFavoriteTokensAtom = atom(null, (get, set) => {
  set(favoriteTokensAtom, { ...DEFAULT_FAVORITE_TOKENS })
})

export const toggleFavoriteTokenAtom = atom(null, (get, set, token: TokenWithLogo) => {
  const { chainId } = get(environmentAtom)
  const favoriteTokensState = get(favoriteTokensAtom)
  const state = { ...favoriteTokensState[chainId] }
  const tokenKey = token.address.toLowerCase()

  if (state[tokenKey]) {
    delete state[tokenKey]
  } else {
    state[tokenKey] = { ...token, name: token.name || '', symbol: token.symbol || '' }
  }

  set(favoriteTokensAtom, {
    ...favoriteTokensState,
    [chainId]: state,
  })
})

function migrateFavoriteTokensAtom(oldStorageKey: string, newStorageKey: string): void {
  try {
    const favoriteV1Raw = localStorage.getItem(oldStorageKey)

    if (!favoriteV1Raw) {
      return
    }

    const state = JSON.parse(favoriteV1Raw) as FavoriteTokens
    const USDC_address = USDC_GNOSIS_CHAIN.address.toLowerCase()

    // Replace USDC with USDC.e on Gnosis chain
    state[SupportedChainId.GNOSIS_CHAIN] = Object.keys(state[SupportedChainId.GNOSIS_CHAIN]).reduce<TokensMap>(
      (acc, address) => {
        if (address.toLowerCase() === USDC_address) {
          const { symbol = '', name = '' } = USDCe_GNOSIS_CHAIN
          acc[USDCe_GNOSIS_CHAIN.address] = { ...USDCe_GNOSIS_CHAIN, symbol, name }
        } else {
          acc[address] = state[SupportedChainId.GNOSIS_CHAIN][address]
        }
        return acc
      },
      {},
    )

    // Save the new state
    localStorage.setItem(newStorageKey, JSON.stringify(state))
  } catch (e) {
    console.error(`Failed to migrate storage from '${oldStorageKey}' to '${newStorageKey}'`, e)
  }

  localStorage.removeItem(oldStorageKey)
}

// One-time v2 -> v3 migration: carry the user's v2 favorites forward but strip
// the CoW governance token (removed from the Ophis defaults). Without this, the
// v2 -> v3 key bump would silently reset every customized favorites list back to
// the defaults (the merger storage never reads the old key). Idempotent: skips
// if v3 already exists; preserves all non-COW entries per chain. Filters by the
// canonical COW_TOKEN_TO_CHAIN map so it tracks the real per-chain COW address
// rather than a hardcoded list.
export function migrateFavoriteTokensAtomV2toV3(oldStorageKey: string, newStorageKey: string): void {
  try {
    // Don't clobber an already-populated v3 (e.g. a user who synced devices).
    if (localStorage.getItem(newStorageKey) !== null) {
      return
    }

    const v2Raw = localStorage.getItem(oldStorageKey)
    if (!v2Raw) {
      return
    }

    const v2State = JSON.parse(v2Raw) as FavoriteTokens
    const migrated = {} as FavoriteTokens

    for (const chainIdKey of Object.keys(v2State)) {
      const chainId = Number(chainIdKey) as SupportedChainId
      const tokens = v2State[chainId]
      if (!tokens) {
        continue
      }
      const cowAddress = COW_TOKEN_TO_CHAIN[chainId]?.address?.toLowerCase()
      migrated[chainId] = Object.keys(tokens).reduce<TokensMap>((acc, address) => {
        if (!cowAddress || address.toLowerCase() !== cowAddress) {
          acc[address] = tokens[address]
        }
        return acc
      }, {})
    }

    localStorage.setItem(newStorageKey, JSON.stringify(migrated))
  } catch (e) {
    console.error(`Failed to migrate favorite tokens from '${oldStorageKey}' to '${newStorageKey}'`, e)
  }
}

// TODO: Remove after 2024-09-15
// Migrate to the new USDC.e on gnosis chain AND update the localStorage key to the US spelling
migrateFavoriteTokensAtom('favouriteTokensAtom:v1', 'favoriteTokensAtom:v2')

// 2026-06-03: carry v2 favorites to v3 minus the CoW governance token. Runs after
// the v1 -> v2 migration so a user still on v1 is upgraded v1 -> v2 -> v3 in order.
migrateFavoriteTokensAtomV2toV3('favoriteTokensAtom:v2', 'favoriteTokensAtom:v3')
