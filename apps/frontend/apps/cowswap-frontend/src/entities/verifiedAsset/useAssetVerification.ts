import type { CircleTokenIdentity } from '@cowprotocol/common-const'

import { useAssetVerificationResolver } from './useAssetVerificationResolver'
import { presetVerification, type Verification } from './verifiedAsset'

export function useAssetVerification(token: CircleTokenIdentity): Verification | undefined {
  const preset = presetVerification(token)
  const verify = useAssetVerificationResolver(!preset && !!token.chainId && !!token.address)
  return preset ?? verify(token)
}
