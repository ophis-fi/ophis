/**
 * Fire a GA4 event.
 *
 * Safe no-op when gtag is absent: initGa4() only installs window.gtag on the
 * production host (swap.ophis.fi), so events on preview/localhost are dropped
 * silently. Never pass PII (names, emails, wallet addresses) in params.
 */
export function trackGa4Event(name: string, params?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { gtag?: (...args: unknown[]) => void }
  w.gtag?.('event', name, params)
}
