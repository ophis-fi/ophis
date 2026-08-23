import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isLocal } from '@cowprotocol/common-utils'

import { resolveOtcWriteAuthorization, resolveOtcWriteFlag, useOtcWriteAuthorization } from 'ophis/otcWrite'

interface OtcFeatureFlags {
  isOtcEnabled?: unknown
  isOtcWriteEnabled?: unknown
}

export function isOtcPageEnabled(flags: OtcFeatureFlags, local: boolean): boolean {
  return flags.isOtcEnabled === true || local
}

/**
 * Write authorization is deliberately stronger than the read-only route flag.
 * It requires the Milestone C flag AND a build explicitly marked for a local
 * mainnet fork. Production builds do not set this mode, so LaunchDarkly or an
 * injected flag object cannot independently make a wallet prompt reachable.
 */
export function isOtcWriteEnabled(
  flags: OtcFeatureFlags,
  local: boolean,
  writeMode: string | undefined,
  localWriteFlag?: string,
): boolean {
  return resolveOtcWriteAuthorization(
    { ...flags, isOtcWriteEnabled: resolveOtcWriteFlag(flags.isOtcWriteEnabled, local, localWriteFlag) },
    local,
    writeMode,
  ).enabled
}

/**
 * True when the OTC surface is enabled: Milestone B now defaults on, while an
 * explicit false flag can still roll it back. Local development also mounts it.
 */
export function useOtcPageEnabled(): boolean {
  return isOtcPageEnabled(useFeatureFlags(), isLocal)
}

export function useOtcWriteEnabled(): boolean {
  return useOtcWriteAuthorization().enabled
}
