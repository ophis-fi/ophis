import { useMediaQuery } from '@cowprotocol/common-hooks'
import { Media } from '@cowprotocol/ui'

import { useIsOphisSwap } from './useIsOphisSwap'

export function useIsMobileSwap(): boolean {
  const isSwap = useIsOphisSwap()
  const isPhone = useMediaQuery(`${Media.upToSmall(false)}, (pointer: coarse) and (max-height: 500px)`)
  return isPhone && isSwap
}
