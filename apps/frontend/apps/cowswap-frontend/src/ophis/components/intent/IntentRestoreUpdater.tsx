/**
 * Restores a stashed swap intent across the wallet-connect handoff.
 *
 * A visitor who submits a natural-language intent while disconnected is routed to
 * the pre-filled swap form, then connects. On connect, cowswap's useSetupTradeState
 * re-derives trade state from the provider and can navigate to the chain's DEFAULT
 * pair (getDefaultTradeRawState), discarding the tokens/amount the visitor chose.
 * This updater detects the disconnected -> connected transition and, on the next
 * macrotask (so it runs AFTER that default navigation), re-navigates to the
 * intended trade.
 *
 * Reliability + scope:
 *  - Fires at most once per mount (consumedRef) and clears the stash the moment it
 *    reads it, so it can never loop with useSetupTradeState.
 *  - The restore is scheduled once and cancelled ONLY on unmount, never on an
 *    effect re-run. A benign re-render (usePrevious flipping prevAccount on the
 *    next render, a second wallet-store write landing account then chainId, or a
 *    pathname change) must not clearTimeout the pending restore.
 *  - SwapUpdaters is shared with the hooks builder (pages/Hooks), so this updater
 *    also mounts there; it never restores while on the /swap/hooks route, so it
 *    cannot yank a user off that builder. It is inert with no stash, so plain
 *    non-intent deep-links and the injected widget (whose landing page never
 *    writes a stash) are unaffected.
 *  - If it mounts already-connected, there was no live handoff, so it drops any
 *    stale stash and stands down.
 *
 * Residual (LOW, documented): the stash is keyed only by time (TTL), not by the
 * exact trade, so an abandoned intent can, within its TTL and in the same tab,
 * re-navigate a later unrelated connect on a plain-swap route. It is one-shot,
 * fully recoverable, and never touches funds.
 */
import { useEffect, useRef } from 'react'

import { usePrevious } from '@cowprotocol/common-hooks'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useLocation, useNavigate } from 'react-router'

import { clearIntentStash, readIntentStash } from './intentStash'

// Amount query keys — mirror TRADE_URL_SELL_AMOUNT_KEY / TRADE_URL_BUY_AMOUNT_KEY
// in modules/trade/const/tradeUrl (kept as literals to avoid coupling the ophis
// layer to the trade module for two stable, public URL-contract strings).
const SELL_AMOUNT_KEY = 'sellAmount'
const BUY_AMOUNT_KEY = 'buyAmount'
// The hooks builder shares SwapUpdaters and lives under /:chain/swap/hooks/...
const HOOKS_ROUTE_RE = /\/swap\/hooks(\/|$)/

export function IntentRestoreUpdater(): null {
  const { account, chainId: walletChainId } = useWalletInfo()
  const prevAccount = usePrevious(account)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const consumedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (consumedRef.current) return

    const justConnected = !prevAccount && !!account
    const connectedAtMount = !!account && prevAccount === account
    if (!justConnected) {
      // Mounted already-connected: no live handoff, drop any stale stash.
      if (connectedAtMount) {
        consumedRef.current = true
        clearIntentStash()
      }
      return
    }

    consumedRef.current = true
    const stash = readIntentStash()
    clearIntentStash()
    if (!stash) return
    // Never pull a user off the hooks builder (shared SwapUpdaters mount).
    if (HOOKS_ROUTE_RE.test(pathname)) return

    // Honour an explicit intent chain; otherwise stay on the connected chain.
    // A no-chain intent stashes chain-agnostic SYMBOLS (see IntentLanding), so
    // this resolves correctly on whatever chain the wallet is on, instead of
    // pinning addresses that were resolved for the landing page's default chain.
    const chainId = stash.chainId ?? walletChainId
    const segments: string[] = []
    if (chainId) segments.push(String(chainId))
    segments.push('swap')
    segments.push(stash.sellToken ? encodeURIComponent(stash.sellToken) : '_')
    if (stash.buyToken) segments.push(encodeURIComponent(stash.buyToken))

    let target = '/' + segments.join('/')
    if (stash.amount) {
      const amountKey =
        stash.field === 'buy' && stash.buyToken ? BUY_AMOUNT_KEY : stash.sellToken ? SELL_AMOUNT_KEY : undefined
      if (amountKey) target += `?${amountKey}=${encodeURIComponent(stash.amount)}`
    }

    // Defer past the current commit so this wins the race against
    // useSetupTradeState's connect-time default navigation. `replace` swaps out
    // that transient wiped-default entry. The timer id lives in a ref and is NOT
    // cleared on effect re-run (only on unmount, below), so a re-render cannot
    // cancel the pending restore and silently drop the intent.
    timerRef.current = setTimeout(() => navigate(target, { replace: true }), 0)
  }, [account, prevAccount, walletChainId, navigate, pathname])

  // Cancel a still-pending restore only when the swap surface unmounts.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return null
}
