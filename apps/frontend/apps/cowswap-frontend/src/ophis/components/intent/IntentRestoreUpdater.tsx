/**
 * Restores a stashed swap intent across the wallet-connect handoff.
 *
 * Mounted on the swap surface (SwapUpdaters). A visitor who submits a
 * natural-language intent while disconnected is routed to the pre-filled swap
 * form, then connects. On connect, cowswap's useSetupTradeState re-derives trade
 * state from the provider and can navigate to the chain's DEFAULT pair
 * (getDefaultTradeRawState), discarding the tokens/amount the visitor chose.
 * This updater detects the disconnected -> connected transition and, on the next
 * macrotask (so it runs AFTER that default navigation), re-navigates to the
 * intended trade.
 *
 * Guarantees:
 *  - Fires at most once per mount (consumedRef) and clears the stash the moment
 *    it reads it, so it can never loop with useSetupTradeState.
 *  - If it mounts already-connected, there was no live handoff, so it just drops
 *    any stale stash and stands down.
 *  - All storage access is best-effort and never throws.
 *
 * Known trade-off: the stash reflects the trade AT INTENT-SUBMIT time. A user who
 * submits an intent, then navigates elsewhere while still disconnected (edits the
 * form, or follows a direct swap link), then connects, is returned to the
 * originally-parsed trade. That path is rare next to the common "submit then
 * connect", and it matches the product intent of holding the searched trade until
 * the user connects.
 *
 * Note on mounting: SwapUpdaters is also mounted inside the injected widget, so
 * this updater technically mounts there too — but the landing page is the only
 * writer of the stash and is not part of the widget, so it is inert there. Limit
 * and advanced surfaces do not mount SwapUpdaters at all.
 */
import { useEffect, useRef } from 'react'

import { usePrevious } from '@cowprotocol/common-hooks'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useNavigate } from 'react-router'

import { clearIntentStash, readIntentStash } from './intentStash'

// Amount query keys — mirror TRADE_URL_SELL_AMOUNT_KEY / TRADE_URL_BUY_AMOUNT_KEY
// in modules/trade/const/tradeUrl (kept as literals to avoid coupling the ophis
// layer to the trade module for two stable, public URL-contract strings).
const SELL_AMOUNT_KEY = 'sellAmount'
const BUY_AMOUNT_KEY = 'buyAmount'

export function IntentRestoreUpdater(): null {
  const { account, chainId: walletChainId } = useWalletInfo()
  const prevAccount = usePrevious(account)
  const navigate = useNavigate()
  const consumedRef = useRef(false)

  useEffect(() => {
    if (consumedRef.current) return

    const justConnected = !prevAccount && !!account
    const connectedAtMount = !!account && prevAccount === account

    if (!justConnected) {
      // Already connected when this updater first mounted: no live intent handoff
      // is in flight, so discard any stale stash and stand down.
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

    // Honour an explicit intent chain; otherwise stay on the connected chain
    // (never force a network switch the user did not ask for). walletChainId is
    // captured HERE, once, so the target is fully built before we defer (see the
    // dependency note below).
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
    // that transient wiped-default entry. When an explicit intent chain differs
    // from the wallet's, cowswap's own rememberedUrlStateRef then carries these
    // tokens through the network switch it triggers.
    const id = setTimeout(() => navigate(target, { replace: true }), 0)
    return () => clearTimeout(id)
    // walletChainId is read ONCE at the connect transition and is deliberately
    // NOT a dependency: were it one, a wallet that publishes account and chainId
    // in separate commits would re-run this effect on the chainId update, whose
    // cleanup would clearTimeout the pending restore — and with consumedRef
    // already set and the stash already cleared, the intent would be lost for
    // good. The target is fully built above, so no later value is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, prevAccount, navigate])

  return null
}
