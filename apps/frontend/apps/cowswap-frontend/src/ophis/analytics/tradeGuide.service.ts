import { mountConsentBanner } from './consentBanner'
import { initGa4 } from './initGa4'
import { trackGa4Event } from './track'

// A guide can be left immediately; start the tag now so a fast CTA can flush.
initGa4({ deferDownload: false })
document.getElementById('analytics-preferences')?.addEventListener('click', () => mountConsentBanner(true))
document.querySelectorAll<HTMLAnchorElement>('[data-trade-cta]').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    event.preventDefault()
    let navigated = false
    const navigate = (): void => {
      if (navigated) return
      navigated = true
      window.clearTimeout(timeout)
      window.location.assign(link.href)
    }
    // A blocked tag must never trap the visitor; wait at most one second.
    const timeout = window.setTimeout(navigate, 1000)
    trackGa4Event('trade_click', {
      destination: 'swap_app',
      chainId: 4663,
      transport_type: 'beacon',
      event_callback: navigate,
      event_timeout: 1000,
    })
  })
})
