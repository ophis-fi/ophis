import { useSetAtom } from 'jotai'
import { useCallback, useEffect } from 'react'

import { SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'

import useSWR, { mutate } from 'swr'

import { getSurplusData } from 'api/cowProtocol/api'
import useNativeCurrency from 'lib/hooks/useNativeCurrency'

import { totalSurplusAtom } from './atoms'
import { useSurplusInvalidationTrigger } from './hooks'

const SURPLUS_SWR_CACHE_KEY = 'getSurplusData'

export function invalidateSurplusSwr(): void {
  mutate((key: unknown) => Array.isArray(key) && key[0] === SURPLUS_SWR_CACHE_KEY, undefined, { revalidate: true })
}

export function TotalSurplusUpdater(): null {
  const { chainId, account } = useWalletInfo()
  const nativeCurrency = useNativeCurrency()
  const setTotalSurplus = useSetAtom(totalSurplusAtom)
  const invalidateCacheTrigger = useSurplusInvalidationTrigger()

  const fetcher = useCallback(
    async ([, chainId, account]: [string, number, string, number]) => {
      const surplusData = await getSurplusData(chainId, account)

      // 2026-05-17 hardening: useNativeCurrency() returns undefined for chains
      // outside our TargetChainId set (user on Polygon/BSC/etc.). Don't build
      // a malformed CurrencyAmount — surplus display gracefully shows nothing.
      if (!surplusData?.totalSurplus || !nativeCurrency) {
        return null
      }

      return CurrencyAmount.fromRawAmount(nativeCurrency, surplusData.totalSurplus)
    },
    [nativeCurrency],
  )

  const {
    data: surplusAmount,
    isLoading,
    error,
  } = useSWR<CurrencyAmount<Currency> | null>(
    // Don't load if required params are missing: https://swr.vercel.app/docs/conditional-fetching
    chainId && account ? [SURPLUS_SWR_CACHE_KEY, chainId, account, invalidateCacheTrigger] : null,
    fetcher,
    { ...SWR_NO_REFRESH_OPTIONS, revalidateIfStale: false },
  )

  useEffect(() => {
    setTotalSurplus({ surplusAmount, isLoading, error })
  }, [error, isLoading, setTotalSurplus, surplusAmount])

  return null
}
