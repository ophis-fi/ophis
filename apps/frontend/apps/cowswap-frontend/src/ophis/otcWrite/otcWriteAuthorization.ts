import { useMemo } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isLocal } from '@cowprotocol/common-utils'

import { OTC_CANARY_POLICY } from './otcCanary.const'
import { useOtcRuntimeControl } from './useOtcRuntimeControl'

import type { OtcWriteRuntimeAuthorization } from './otcWrite.types'

interface OtcWriteFlags {
  isOtcEnabled?: unknown
  isOtcWriteEnabled?: unknown
}

export interface OtcWriteAuthorizationState {
  enabled: boolean
  configured: boolean
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
  const configured =
    authorization.readFlag === true &&
    ((authorization.isLocal && authorization.writeMode === 'fork') ||
      (authorization.writeMode === 'canary' && OTC_CANARY_POLICY.accounts.length > 0))
  const enabled = configured && authorization.writeFlag === true
  return {
    enabled,
    configured: authorization.writeMode === 'canary' ? configured : enabled,
    authorization,
  }
}

export function useOtcWriteAuthorization(): OtcWriteAuthorizationState {
  const flags = useFeatureFlags()
  const readFlag = flags.isOtcEnabled
  const localWriteFlag = process.env.REACT_APP_OTC_WRITE_FLAG
  const writeMode = process.env.REACT_APP_OTC_WRITE_MODE
  const runtimeFlag = useOtcRuntimeControl(
    writeMode === 'canary' && readFlag === true && OTC_CANARY_POLICY.accounts.length > 0,
  )
  const writeFlag =
    writeMode === 'canary' ? runtimeFlag : resolveOtcWriteFlag(flags.isOtcWriteEnabled, isLocal, localWriteFlag)
  return useMemo(
    () => resolveOtcWriteAuthorization({ isOtcEnabled: readFlag, isOtcWriteEnabled: writeFlag }, isLocal, writeMode),
    [readFlag, writeFlag, writeMode],
  )
}
