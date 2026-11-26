import { atom, useAtomValue } from 'jotai'
import { loadable } from 'jotai/utils'

import type { CircleTokenIdentity } from '@cowprotocol/common-const'

import { presetVerification, stockIssuer, type Verification } from './verifiedAsset'

// The swap can render common assets immediately. All stock rows share one local, code-split snapshot.
const stockIndexAtom = loadable(atom(async () => (await import('./stockContracts.json')).default))
const skipStocksAtom = atom(null)

export function useAssetVerification(token: CircleTokenIdentity): Verification | undefined {
  const preset = presetVerification(token)
  const { chainId, address } = token
  const index = useAtomValue(preset || !chainId || !address ? skipStocksAtom : stockIndexAtom)
  return (
    preset ??
    (index?.state === 'hasData' && chainId && address
      ? stockIssuer(index.data, chainId, address, token.symbol)
      : undefined)
  )
}
