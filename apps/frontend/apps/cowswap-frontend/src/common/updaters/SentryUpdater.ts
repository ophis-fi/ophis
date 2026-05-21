import { useEffect } from 'react'

import { useIsWindowVisible } from '@cowprotocol/common-hooks'
import { SentryTag } from '@cowprotocol/common-utils'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import * as Sentry from '@sentry/browser'

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { useTradeState } from 'modules/trade'

export function SentryUpdater(): null {
  const { account, chainId } = useWalletInfo()
  const { walletName } = useWalletDetails()
  const windowVisible = useIsWindowVisible()

  const { state } = useTradeState()

  const { inputCurrencyId, outputCurrencyId } = state || {}

  useEffect(() => {
    if (windowVisible) {
      // Sentry v8 (2026-05-21): `Sentry.configureScope(cb)` was removed.
      // The new API is `Sentry.getCurrentScope()` which returns the
      // current scope directly so the operator can mutate tags inline.
      // Equivalent semantics to the v7 callback form for our usage —
      // we never relied on the callback's automatic restore behavior.
      const scope = Sentry.getCurrentScope()
      scope.setTag('walletAddress', account)
      scope.setTag('sellToken', inputCurrencyId)
      scope.setTag('buyToken', outputCurrencyId)
      scope.setTag('chainId', chainId)
      scope.setTag('walletConnected', !!account)
      scope.setTag('wallet', walletName || SentryTag.UNKNOWN)
    }
  }, [
    // user
    account,
    chainId,
    walletName,
    // tokens
    inputCurrencyId,
    outputCurrencyId,
    // window visibility check
    windowVisible,
  ])

  return null
}
