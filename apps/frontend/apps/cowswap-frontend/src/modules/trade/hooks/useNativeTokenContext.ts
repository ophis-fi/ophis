import { useMemo } from 'react'

import { getWrappedToken } from '@cowprotocol/common-utils'

import useNativeCurrency from 'lib/hooks/useNativeCurrency'

import { useIsNativeIn, useIsNativeOut } from './useIsNativeInOrOut'
import { useIsWrappedIn, useIsWrappedOut } from './useIsWrappedInOrOut'

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useNativeTokenContext() {
  const native = useNativeCurrency()
  // 2026-05-17: native is undefined for unsupported wallet chains; downstream
  // getWrappedToken would crash. Short-circuit wrapped to undefined too.
  const wrappedToken = native ? getWrappedToken(native) : undefined

  const isNativeIn = useIsNativeIn()
  const isNativeOut = useIsNativeOut()

  const isWrappedIn = useIsWrappedIn()
  const isWrappedOut = useIsWrappedOut()

  return useMemo(() => {
    return {
      isNativeIn,
      isNativeOut,
      isWrappedIn,
      isWrappedOut,
      wrappedToken,
      native,
    }
  }, [isNativeIn, isNativeOut, isWrappedIn, isWrappedOut, wrappedToken, native])
}
