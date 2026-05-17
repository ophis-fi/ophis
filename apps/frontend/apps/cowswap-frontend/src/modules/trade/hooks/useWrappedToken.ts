import { TokenWithLogo } from '@cowprotocol/common-const'
import { getWrappedToken } from '@cowprotocol/common-utils'

import useNativeCurrency from 'lib/hooks/useNativeCurrency'

// Return type now `| undefined` (2026-05-17 hardening): mirrors
// useNativeCurrency, since wrapped(undefined) has no sensible value.
// Callers must guard before passing this where a TokenWithLogo is required.
export function useWrappedToken(): TokenWithLogo | undefined {
  const native = useNativeCurrency()
  return native ? getWrappedToken(native) : undefined
}
