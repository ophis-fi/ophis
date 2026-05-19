/**
 * Tier-fetch opt-in gate (Phase 3 audit M, 2026-05-19).
 *
 * Privacy concern: `useTier` previously fetched
 *   GET https://rebates.ophis.fi/tier/${wallet}
 * the moment any wallet connected, regardless of whether the user ever
 * intended to look at their rebate tier. That meant the rebates server
 * learned every visitor's wallet address as a side-effect of merely
 * loading the page with a connected wallet — purpose-limitation
 * violation (GDPR Art. 5(1)(b)) and a passive PII leak.
 *
 * Fix: gate the tier fetch behind an explicit opt-in stored in
 * localStorage (`ophis.rebates.optIn`). Until the user clicks the
 * opt-in CTA on the TierChip placeholder, the hook short-circuits and
 * NO request is made.
 *
 * useSyncExternalStore wires localStorage into React's render cycle so
 * any component reading the flag re-renders when it flips. Cross-tab
 * sync is free via the `storage` event; same-tab updates require us to
 * manually dispatch a synthetic event from `setRebatesOptIn` because
 * `storage` only fires in *other* tabs (per WHATWG storage spec).
 */
import { useSyncExternalStore } from 'react'

export const REBATES_OPT_IN_KEY = 'ophis.rebates.optIn'
const SAME_TAB_EVENT = 'ophis.rebates.optIn.changed'

function readFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(REBATES_OPT_IN_KEY) === 'true'
  } catch {
    // localStorage blocked (private mode, ITP, etc.) — treat as not
    // opted in. Safer default for privacy.
    return false
  }
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key === REBATES_OPT_IN_KEY) callback()
  }
  const onSameTab = (): void => callback()
  window.addEventListener('storage', onStorage)
  window.addEventListener(SAME_TAB_EVENT, onSameTab)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(SAME_TAB_EVENT, onSameTab)
  }
}

// SSR snapshot — assume not opted in. Aligns with privacy-first default.
const SERVER_SNAPSHOT = false
function getServerSnapshot(): boolean {
  return SERVER_SNAPSHOT
}

export function useRebatesOptIn(): boolean {
  return useSyncExternalStore(subscribe, readFlag, getServerSnapshot)
}

export function setRebatesOptIn(value: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(REBATES_OPT_IN_KEY, 'true')
    } else {
      window.localStorage.removeItem(REBATES_OPT_IN_KEY)
    }
  } catch {
    // localStorage blocked — there's no way to persist the choice.
    // Fail open: don't crash, just skip persistence.
    return
  }
  // Fire same-tab notification so subscribers update without a reload.
  window.dispatchEvent(new Event(SAME_TAB_EVENT))
}
