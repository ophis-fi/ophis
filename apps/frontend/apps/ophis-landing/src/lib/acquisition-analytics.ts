type Gtag = (command: 'event', name: string, params: Record<string, string>) => void

type Acquisition = { event: 'trade_click' | 'integration_click'; destination: string }

const INTEGRATION_DOC_PATHS = new Set([
  '/agent-wallet-policies',
  '/ai-agents',
  '/intent-api',
  '/migrating-from-odos',
  '/partners',
])

function normalizedPath(url: URL): string {
  return url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname
}

function classifyAcquisition(url: URL): Acquisition | undefined {
  if (
    url.hostname === 'swap.ophis.fi' &&
    url.pathname === '/' &&
    (!url.hash || /^#\/(?:\d+\/)?(?:swap|limit|advanced)(?:[/?]|$)/.test(url.hash))
  ) {
    return { event: 'trade_click', destination: 'swap_app' }
  }

  const path = normalizedPath(url)
  if (url.hostname === 'docs.ophis.fi' && INTEGRATION_DOC_PATHS.has(path)) {
    return { event: 'integration_click', destination: 'docs' }
  }
  if (url.hostname === 'mcp.ophis.fi' && path === '/mcp') {
    return { event: 'integration_click', destination: 'mcp' }
  }
  if (url.hostname === 'business.ophis.fi' && path === '/') {
    return { event: 'integration_click', destination: 'business' }
  }
  if (url.hostname === 'github.com' && path === '/ophis-fi/ophis/tree/main/packages/sdk') {
    return { event: 'integration_click', destination: 'github' }
  }
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return

  const link = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!link) return

  const url = new URL(link.href, location.href)
  const acquisition = classifyAcquisition(url)
  if (!acquisition) return

  const gtag = (window as unknown as { gtag?: Gtag }).gtag
  try {
    const canonical = new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || 'https://ophis.fi/')
    gtag?.('event', acquisition.event, {
      destination: acquisition.destination,
      // Attribute guide CTAs to their canonical page without leaking query/hash
      // values. Keep campaign attribution on the session, not internal links.
      page_location: canonical.origin === 'https://ophis.fi' ? canonical.origin + canonical.pathname : 'https://ophis.fi/',
    })
  } catch {
    // Analytics is best-effort and must never interrupt navigation.
  }
})
