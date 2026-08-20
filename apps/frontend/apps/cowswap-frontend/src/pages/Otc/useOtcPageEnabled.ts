import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isLocal } from '@cowprotocol/common-utils'

/**
 * True when the OTC surface is enabled: the isOtcEnabled feature flag is
 * explicitly true (it is absent from useFeatureFlags defaults, so production
 * ships OFF), or the build is a local dev environment.
 */
export function useOtcPageEnabled(): boolean {
  const { isOtcEnabled } = useFeatureFlags()
  return isOtcEnabled === true || isLocal
}
