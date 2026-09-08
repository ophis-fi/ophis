import { useAtom } from 'jotai'
import { useMemo } from 'react'

import { atomWithQuery } from 'jotai-tanstack-query'

import { readOtcRuntimeControl } from './otcRuntimeControl'

export function useOtcRuntimeControl(enabled: boolean): boolean {
  const controlAtom = useMemo(
    () =>
      atomWithQuery<boolean, Error>(() => ({
        queryKey: ['ophis-otc-runtime-control'],
        queryFn: readOtcRuntimeControl,
        enabled,
        retry: false,
        gcTime: 0,
        refetchInterval: 5_000,
        refetchIntervalInBackground: true,
        refetchOnWindowFocus: true,
      })),
    [enabled],
  )
  const [query] = useAtom(controlAtom)
  return enabled && query.data === true && query.error === null
}
