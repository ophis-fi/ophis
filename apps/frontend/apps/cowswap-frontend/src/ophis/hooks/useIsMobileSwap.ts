import { useMediaQuery } from '@cowprotocol/common-hooks'
import { isInjectedWidget } from '@cowprotocol/common-utils'
import { Media } from '@cowprotocol/ui'

import { useLocation } from 'react-router'

export function useIsMobileSwap(): boolean {
  const { pathname } = useLocation()
  const isPhone = useMediaQuery(`${Media.upToSmall(false)}, (pointer: coarse) and (max-height: 500px)`)
  return isPhone && !isInjectedWidget() && /^\/(?:\d+\/)?swap(?:$|\/(?!hooks(?:\/|$)))/.test(pathname)
}
