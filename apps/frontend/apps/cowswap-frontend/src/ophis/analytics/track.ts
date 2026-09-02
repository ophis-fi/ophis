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
  try {
    w.gtag?.('event', name, {
      ...params,
      // GA4 otherwise attaches the browser's full URL, including token
      // addresses and hash-router query parameters, to every custom event.
      page_location: getSanitizedPageLocation(window.location),
    })
  } catch {
    // Analytics is best-effort and must never interrupt quoting or order state.
  }
}

type PageLocation = Pick<Location, 'origin' | 'pathname' | 'hash'>

// Collapse 0x-addresses (wallet/token/proxy) and discard route query parameters
// so analytics can aggregate by route without receiving user-controlled data.
export function getSanitizedPagePath(pageLocation: Pick<PageLocation, 'pathname' | 'hash'>): string {
  const pathWithoutQuery = `${pageLocation.pathname}${pageLocation.hash}`.split('?', 1)[0]
  return pathWithoutQuery.replace(/0x[a-fA-F0-9]{40}/g, '0x_addr')
}

export function getSanitizedPageLocation(pageLocation: PageLocation): string {
  return pageLocation.origin + getSanitizedPagePath(pageLocation)
}
