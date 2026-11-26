import { atom, useAtomValue } from 'jotai'
import { loadable } from 'jotai/utils'
import { useCallback } from 'react'

import type { CircleTokenIdentity } from '@cowprotocol/common-const'

import { presetVerification, stockIssuer, type Verification } from './verifiedAsset'

// The swap can render common assets immediately. All stock rows share one local, code-split snapshot.
const stockIndexAtom = loadable(atom(async () => (await import('./stockContracts.json')).default))
const skipStocksAtom = atom(null)

export function useAssetVerificationResolver(enabled = true): (token: CircleTokenIdentity) => Verification | undefined {
  const index = useAtomValue(enabled ? stockIndexAtom : skipStocksAtom)
  return useCallback(
    (token: CircleTokenIdentity) => {
      const preset = presetVerification(token)
      if (preset || !token.chainId || !token.address || index?.state !== 'hasData') return preset
      return stockIssuer(index.data, token.chainId, token.address, token.symbol)
    },
    [index],
  )
}
