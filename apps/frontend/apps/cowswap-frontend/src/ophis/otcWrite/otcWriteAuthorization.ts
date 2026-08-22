import { useMemo } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isLocal } from '@cowprotocol/common-utils'

import type { OtcWriteRuntimeAuthorization } from './otcWrite.types'

interface OtcWriteFlags {
  isOtcEnabled?: unknown
  isOtcWriteEnabled?: unknown
}

export interface OtcWriteAuthorizationState {
  enabled: boolean
  authorization: OtcWriteRuntimeAuthorization
}

export function resolveOtcWriteFlag(remoteFlag: unknown, local: boolean, localFlag: string | undefined): boolean {
  return remoteFlag === true || (local && localFlag === 'true')
}

export function resolveOtcWriteAuthorization(
  flags: OtcWriteFlags,
  local: boolean,
  writeMode: string | undefined,
): OtcWriteAuthorizationState {
  const authorization: OtcWriteRuntimeAuthorization = {
    isLocal: local,
    readFlag: flags.isOtcEnabled,
    writeFlag: flags.isOtcWriteEnabled,
    writeMode,
  }
  return {
    enabled:
      authorization.readFlag === true &&
      authorization.writeFlag === true &&
      authorization.isLocal &&
      authorization.writeMode === 'fork',
    authorization,
  }
}

export function useOtcWriteAuthorization(): OtcWriteAuthorizationState {
  const flags = useFeatureFlags()
  const readFlag = flags.isOtcEnabled
  const localWriteFlag = process.env.REACT_APP_OTC_WRITE_FLAG
  const writeFlag = resolveOtcWriteFlag(flags.isOtcWriteEnabled, isLocal, localWriteFlag)
  const writeMode = process.env.REACT_APP_OTC_WRITE_MODE
  return useMemo(
    () => resolveOtcWriteAuthorization({ isOtcEnabled: readFlag, isOtcWriteEnabled: writeFlag }, isLocal, writeMode),
    [readFlag, writeFlag, writeMode],
  )
}
