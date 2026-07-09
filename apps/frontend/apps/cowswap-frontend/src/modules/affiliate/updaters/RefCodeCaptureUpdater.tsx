/**
 * RefCodeCaptureUpdater — app-wide updater (Surface A) for the Ophis
 * native affiliate program.
 *
 * Responsibilities:
 *   1. Capture `?ref=CODE` from the URL on load and persist it (via the
 *      existing dependency-light trader saved-code atom) so it survives
 *      navigation and wallet connect.
 *   2. Once a wallet CONNECTS AND a saved ref code exists AND that
 *      (wallet, code) pair is not yet bound locally, prove the referred
 *      wallet controls its address with an EIP-191 `personal_sign`
 *      (reusing the shared `useOphisAffiliateSign` path — the same signer
 *      the /ref/codes mint flow uses) and call
 *      POST /ref/bind { referredWallet, code, issued, signature }.
 *
 * Binding outcomes are treated as terminal-success-silent so we never retry
 * on every render: a 200 `bound`, a 200 `alreadyBound`, and the 409
 * (wallet has prior trade history / not net-new) all mark the pair bound
 * locally. Any other failure is logged only and left un-marked so a later
 * session can retry; the UI is never blocked.
 *
 * The signature is requested at most once per (wallet, code) per mounted
 * session: an in-flight guard prevents concurrent prompts, and a user
 * rejection (EIP-1193 4001 / ethers ACTION_REJECTED) is recorded so we do
 * NOT re-prompt aggressively — the captured `?ref` code stays persisted, so
 * a later connect / reload / code change is still free to retry. Binding is
 * never auto-spammed and never blocks the rest of the app.
 *
 * Renders nothing.
 */
import { ReactNode, useEffect, useRef } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { useAtomValue, useSetAtom } from 'jotai'

import { useAffiliateTraderCodeFromUrl } from '../hooks/useAffiliateTraderCodeFromUrl'
import { useOphisAffiliateSign } from '../hooks/useOphisAffiliateSign'
import { formatRefCode } from '../lib/affiliateProgramUtils'
import { AffiliateApiError, bindRefCode } from '../lib/ophisAffiliateApi'
import {
  affiliatePendingRefCodeAtom,
  affiliateTraderSavedCodeAtom,
  setAffiliateTraderSavedCodeAtom,
} from '../state/affiliateTraderSavedCodeAtom'
import { isRefBoundAtom, markRefBoundAtom } from '../state/refBoundWalletsAtom'

function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code
  return code === 4001 || code === 'ACTION_REJECTED'
}

export function RefCodeCaptureUpdater(): ReactNode {
  const { account } = useWalletInfo()
  const { savedCode } = useAtomValue(affiliateTraderSavedCodeAtom)
  const setSavedCode = useSetAtom(setAffiliateTraderSavedCodeAtom)
  const isRefBound = useAtomValue(isRefBoundAtom)
  const markRefBound = useSetAtom(markRefBoundAtom)
  const signAffiliateAction = useOphisAffiliateSign(account)

  // Capture ?ref=CODE from the URL → persist for this wallet bucket, or into
  // the wallet-independent pending slot when no wallet is connected yet.
  useAffiliateTraderCodeFromUrl((code) => {
    setSavedCode({ savedCode: code })
  })

  // Promote a pre-connect captured code to the connecting wallet's bucket.
  // The first wallet to connect claims the pending code; the backend still
  // enforces net-new + first-bind-wins, so this only affects attribution
  // of wallets that would otherwise carry no code at all. Re-validate the
  // code shape on the way out: the pending slot is localStorage, which is
  // user-editable and therefore a trust boundary.
  const pendingCode = useAtomValue(affiliatePendingRefCodeAtom)
  const setPendingCode = useSetAtom(affiliatePendingRefCodeAtom)

  useEffect(() => {
    if (!account || !pendingCode) return
    const validated = formatRefCode(pendingCode)
    if (validated) {
      setSavedCode({ savedCode: validated })
    }
    setPendingCode(undefined)
  }, [account, pendingCode, setSavedCode, setPendingCode])

  // Guard against duplicate in-flight binds for the same (wallet, code).
  const inFlightKeyRef = useRef<string | undefined>(undefined)
  // Keys the user rejected this mounted session — don't re-prompt for them.
  const rejectedKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!account || !savedCode) return
    // Codes are canonical LOWERCASE end-to-end: the backend mints + looks up
    // lowercase and rebuilds the signed message from the lowercased code. The
    // display layer upper-cases for readability, so normalize here before signing,
    // binding, and dedup-keying — otherwise the signed message and the DB lookup
    // both miss and every URL bind silently fails.
    const code = savedCode.toLowerCase()
    if (isRefBound(account, code)) return

    const key = `${account.toLowerCase()}:${code}`
    if (inFlightKeyRef.current === key) return
    if (rejectedKeysRef.current.has(key)) return
    inFlightKeyRef.current = key

    let cancelled = false

    // Sign first (proves the referred wallet controls its address), then bind.
    // The action string carries the code so the backend rebuilds the exact
    // `Ophis bind referral code <code>\nAddress: <wallet>\nIssued: <issued>`.
    signAffiliateAction(`bind referral code ${code}`)
      .then((signed) => {
        if (cancelled) return undefined
        return bindRefCode({
          referredWallet: account,
          code,
          issued: signed.issued,
          signature: signed.signature,
        })
      })
      .then((res) => {
        if (cancelled || !res) return
        // 200: either freshly bound or already bound — terminal either way.
        if (res.bound || res.alreadyBound) {
          markRefBound({ wallet: account, code })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // User rejected the signature: do not bind, do not loop. Record the
        // key so we stop re-prompting this session; a later trigger can retry.
        if (isUserRejection(error)) {
          rejectedKeysRef.current.add(key)
          return
        }
        // 409 (wallet not net-new) and 400 (invalid/inactive code) are
        // DETERMINISTIC, non-retryable rejections: mark terminal locally so we stop
        // re-prompting the signature. Transient errors (5xx/network) stay un-marked
        // for a future retry.
        if (error instanceof AffiliateApiError && (error.status === 409 || error.status === 400)) {
          markRefBound({ wallet: account, code })
          return
        }
        // Transient (5xx / network / CORS / timeout): left un-marked for a later
        // retry. warn (not debug) so a persistent backend/transport break — e.g.
        // the CORS-preflight outage that blocked every bind — is visible in logs.
        console.warn('[RefCodeCaptureUpdater] ref bind failed (non-blocking, will retry):', error)
      })
      .finally(() => {
        if (inFlightKeyRef.current === key) inFlightKeyRef.current = undefined
      })

    return () => {
      cancelled = true
    }
  }, [account, savedCode, isRefBound, markRefBound, signAffiliateAction])

  return null
}
