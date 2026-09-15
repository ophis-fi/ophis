import { isInjectedWidget } from '@cowprotocol/common-utils'

import { useLocation } from 'react-router'

/** Standalone swap styling; partner embeds and hook builders keep their own UI. */
export function useIsOphisSwap(): boolean {
  const { pathname } = useLocation()
  return !isInjectedWidget() && /^\/(?:\d+\/)?swap(?:$|\/(?!hooks(?:\/|$)))/.test(pathname)
}
