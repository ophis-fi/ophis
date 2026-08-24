import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { areAddressesEqual, Nullish } from '@cowprotocol/cow-sdk'

import { COINBASE_TOKENIZED_STOCKS_LIST_SOURCE } from '../../const/tokensLists'
import { listsStatesMapAtom } from '../../state/tokenLists/tokenListsStateAtom'

/**
 * Ophis: true when the token is one of Coinbase's tokenized stocks on Base, judged by
 * membership in the shipped list (same mechanism as useIsXstockToken), so the swap form
 * can show the B20 asset panel without waiting on the metadata endpoint.
 */
export function useIsCoinbaseStockToken(token: Nullish<{ address: string }>): boolean {
  const listStatesMap = useAtomValue(listsStatesMapAtom)
  const listState = listStatesMap[COINBASE_TOKENIZED_STOCKS_LIST_SOURCE]

  return useMemo(() => {
    if (!listState || !token) return false

    for (const item of listState.list.tokens) {
      if (areAddressesEqual(item.address, token.address)) return true
    }

    return false
  }, [listState, token])
}
