/**
 * RefCodeCaptureUpdater — app-wide updater (Surface A) for the Ophis
 * native affiliate program.
 *
 * Responsibilities:
 *   1. Capture `?ref=CODE` from the URL on load and persist it (via the
 *      existing dependency-light trader saved-code atom) so it survives
 *      navigation and wallet connect.
 *   2. Once a wallet connects AND a saved ref code exists AND that
 *      (wallet, code) pair is not yet bound locally, call
 *      POST /ref/bind { referredWallet, code }.
 *
 * Binding outcomes are treated as terminal-success-silent so we never retry
 * on every render: a 200 `bound`, a 200 `alreadyBound`, and the 409
 * (wallet has prior trade history / not net-new) all mark the pair bound
 * locally. Any other failure is logged only and left un-marked so a later
 * session can retry; the UI is never blocked.
 *
 * Renders nothing.
 */
import { ReactNode, useEffect, useRef } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { useAtomValue, useSetAtom } from 'jotai'

import { useAffiliateTraderCodeFromUrl } from '../hooks/useAffiliateTraderCodeFromUrl'
import { AffiliateApiError, bindRefCode } from '../lib/ophisAffiliateApi'
import { affiliateTraderSavedCodeAtom, setAffiliateTraderSavedCodeAtom } from '../state/affiliateTraderSavedCodeAtom'
import { isRefBoundAtom, markRefBoundAtom } from '../state/refBoundWalletsAtom'

export function RefCodeCaptureUpdater(): ReactNode {
  const { account } = useWalletInfo()
  const { savedCode } = useAtomValue(affiliateTraderSavedCodeAtom)
  const setSavedCode = useSetAtom(setAffiliateTraderSavedCodeAtom)
  const isRefBound = useAtomValue(isRefBoundAtom)
  const markRefBound = useSetAtom(markRefBoundAtom)

  // Capture ?ref=CODE from the URL → persist for this wallet bucket.
  useAffiliateTraderCodeFromUrl((code) => {
    setSavedCode({ savedCode: code })
  })

  // Guard against duplicate in-flight binds for the same (wallet, code).
  const inFlightKeyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!account || !savedCode) return
    if (isRefBound(account, savedCode)) return

    const key = `${account.toLowerCase()}:${savedCode.toLowerCase()}`
    if (inFlightKeyRef.current === key) return
    inFlightKeyRef.current = key

    let cancelled = false

    bindRefCode(account, savedCode)
      .then((res) => {
        if (cancelled) return
        // 200: either freshly bound or already bound — terminal either way.
        if (res.bound || res.alreadyBound) {
          markRefBound({ wallet: account, code: savedCode })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // 409 = wallet has prior trade history (not net-new). Terminal:
        // mark bound locally so we stop retrying. Any other error is logged
        // and left un-marked for a future retry.
        if (error instanceof AffiliateApiError && error.status === 409) {
          markRefBound({ wallet: account, code: savedCode })
          return
        }
        console.debug('[RefCodeCaptureUpdater] ref bind failed (non-blocking):', error)
      })
      .finally(() => {
        if (inFlightKeyRef.current === key) inFlightKeyRef.current = undefined
      })

    return () => {
      cancelled = true
    }
  }, [account, savedCode, isRefBound, markRefBound])

  return null
}
