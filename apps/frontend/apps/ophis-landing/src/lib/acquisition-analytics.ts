type Gtag = (command: 'event', name: string, params: Record<string, string>) => void

const DESTINATIONS: Record<string, { event: string; destination: string }> = {
  'swap.ophis.fi': { event: 'trade_click', destination: 'swap_app' },
  'docs.ophis.fi': { event: 'integration_click', destination: 'docs' },
  'mcp.ophis.fi': { event: 'integration_click', destination: 'mcp' },
  'business.ophis.fi': { event: 'integration_click', destination: 'business' },
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return

  const link = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!link) return

  const url = new URL(link.href, location.href)
  const acquisition = DESTINATIONS[url.hostname]
  if (!acquisition && !(url.hostname === 'github.com' && url.pathname.includes('/ophis-fi/ophis'))) return

  const gtag = (window as unknown as { gtag?: Gtag }).gtag
  try {
    gtag?.('event', acquisition?.event ?? 'integration_click', {
      destination: acquisition?.destination ?? 'github',
    })
  } catch {
    // Analytics is best-effort and must never interrupt navigation.
  }
})
