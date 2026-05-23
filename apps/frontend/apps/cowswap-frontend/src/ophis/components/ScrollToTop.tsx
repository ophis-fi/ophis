/**
 * ScrollToTop — resets window scroll position on every route change.
 *
 * Without this, clicking a footer link while scrolled to the bottom of
 * a long page lands the next page also scrolled to the bottom. React
 * Router does not auto-scroll on navigation; the responsibility is
 * client-side. Mount once at the App root, below the Router context.
 *
 * Hash-only changes (#section) are NOT scrolled — those are explicit
 * intra-page anchors that should preserve the user's section jump.
 */
import { useEffect } from 'react'

import { useLocation } from 'react-router'

export function ScrollToTop(): null {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])

  return null
}
