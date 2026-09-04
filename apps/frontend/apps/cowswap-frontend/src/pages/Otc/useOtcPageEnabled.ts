import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isLocal } from '@cowprotocol/common-utils'

/**
 * True when the OTC surface is enabled: the isOtcEnabled feature flag is
 * explicitly true, or the build is a local dev environment. Ophis defaults
 * this flag on for the reviewed, read-only Milestone B surface.
 */
export function useOtcPageEnabled(): boolean {
  const { isOtcEnabled } = useFeatureFlags()
  return isOtcEnabled === true || isLocal
}
