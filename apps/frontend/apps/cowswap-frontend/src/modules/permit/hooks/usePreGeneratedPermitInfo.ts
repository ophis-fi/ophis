import { useMemo } from 'react'

import { COW_API_UNSUPPORTED_CHAIN_IDS, SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import { PermitInfo } from '@cowprotocol/permit-utils'
import { useWalletInfo } from '@cowprotocol/wallet'

import useSWR from 'swr'

import { PRE_GENERATED_PERMIT_URL } from '../const'

/**
 * Fetch pre-generated permit info (stored in token-lists repo) for all tokens
 *
 * Caches result with SWR until a page refresh
 */
export function usePreGeneratedPermitInfo(): {
  allPermitInfo: Record<string, PermitInfo>
  isLoading: boolean
} {
  const { chainId } = useWalletInfo()

  const hasPreGenerated = !COW_API_UNSUPPORTED_CHAIN_IDS.has(chainId)
  const url = hasPreGenerated ? `${PRE_GENERATED_PERMIT_URL}.${chainId}.json` : null

  const { data, isLoading } = useSWR(
    url,
    (url: string): Promise<Record<string, PermitInfo>> =>
      fetch(url).then((r) => {
        if (!r.ok) {
          // Don't try to parse 403/404 HTML/XML as JSON; treat as empty.
          return {}
        }
        return r.json()
      }),
    { ...SWR_NO_REFRESH_OPTIONS, fallbackData: {} },
  )

  return useMemo(() => ({ allPermitInfo: data, isLoading }), [data, isLoading])
}
