import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo } from 'react'

import { DEFAULT_APP_CODE, SAFE_APP_CODE } from '@cowprotocol/common-const'
import { useIsSafeApp } from '@cowprotocol/wallet'

import { appDataHooksAtom, appDataInfoAtom } from './state/atoms'
import { AppDataInfo } from './types'
import { sumVolumeFeeBps } from './utils/sumVolumeFeeBps'

const APP_CODE = process.env.REACT_APP_APP_CODE

export function useAppData(): AppDataInfo | null {
  return useAtomValue(appDataInfoAtom)
}

/**
 * The flat Volume bps the CURRENT appData actually signs, summed over every
 * partnerFee entry. The fee row and the receive-amount maths must read this, not
 * the volumeFee pipeline alone: with a host widget override the order carries the
 * host's fee AND the Ophis 1 bp base, and the pipeline knows only the former.
 * undefined while no appData is built yet (callers fall back to the pipeline).
 */
export function useAppDataVolumeFeeBps(): number | undefined {
  const appData = useAtomValue(appDataInfoAtom)
  return useMemo(() => sumVolumeFeeBps(appData?.doc.metadata.partnerFee), [appData])
}

export function useAppCode(): string | null {
  const isSafeApp = useIsSafeApp()

  return useMemo(() => {
    if (APP_CODE) {
      // appCode coming from env var has priority
      return APP_CODE
    }

    return isSafeApp ? SAFE_APP_CODE : DEFAULT_APP_CODE
  }, [isSafeApp])
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useUpdateAppDataHooks() {
  return useSetAtom(appDataHooksAtom)
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useAppDataHooks() {
  return useAtomValue(appDataHooksAtom)
}
