import { isInjectedWidget } from '@cowprotocol/common-utils'

import { useMatch } from 'react-router'

import { CCTP_ENABLED } from 'common/constants/featureFlags'
import { Routes } from 'common/constants/routes'

export function useIsCctpEnabled(): boolean {
  const isSwap = useMatch(Routes.SWAP)
  const isHooks = useMatch(Routes.HOOKS)
  return CCTP_ENABLED && !!isSwap && !isHooks && !isInjectedWidget()
}
