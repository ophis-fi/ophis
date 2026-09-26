import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'

import { favoriteTokensListAtom } from '../../../state/tokens/favoriteTokensAtom'
import { useTokensByAddressMap } from '../useTokensByAddressMap'

export function useFavoriteTokens(): TokenWithLogo[] {
  const favorites = useAtomValue(favoriteTokensListAtom)
  const tokensByAddress = useTokensByAddressMap()

  return useMemo(
    () =>
      favorites.map((token) => {
        const listed = tokensByAddress[getAddressKey(token.address)]
        return listed?.chainId === token.chainId ? listed : token
      }),
    [favorites, tokensByAddress],
  )
}
