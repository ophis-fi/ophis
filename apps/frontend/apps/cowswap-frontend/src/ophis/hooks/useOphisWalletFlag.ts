import { useEffect } from 'react'

import { trackGa4Event } from 'ophis/analytics/track'

/**
 * Writes `ophis_wallet_connected = "true"` to localStorage on FIRST wallet
 * connect, so the landing's returning-trader fast-path redirect (in
 * apps/ophis-landing/src/layouts/Base.astro) can short-circuit landing
 * load for known users.
 *
 * The flag is sticky once set — we don't clear it on disconnect because
 * a disconnected returning trader who reloads ophis.fi still wants to
 * land in the swap UI by intent.
 *
 * Also fires the GA4 `wallet_connect` funnel event. The effect deps are
 * [isConnected], so it runs on the change-to-true transition (and once on
 * mount if already connected). No PII: no address or provider is sent.
 */
export function useOphisWalletFlag(isConnected: boolean): void {
  useEffect(() => {
    if (!isConnected) return
    trackGa4Event('wallet_connect')
    try {
      if (localStorage.getItem('ophis_wallet_connected') !== 'true') {
        localStorage.setItem('ophis_wallet_connected', 'true')
      }
    } catch {
      // localStorage may be blocked by ITP / Safari private / iframe — silent ignore
    }
  }, [isConnected])
}
