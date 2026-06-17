/**
 * Google Analytics 4 (gtag) bootstrap for the Ophis swap app.
 *
 * Why a bundled module instead of the standard inline snippet: the swap app
 * deploys to Cloudflare Pages under a strict CSP (public/_headers) with NO
 * 'unsafe-inline' in script-src, so an inline gtag bootstrap would be blocked.
 * This module is part of the 'self' bundle; it injects gtag.js FIRST-PARTY from
 * the Cloudflare Google Tag Gateway endpoint (/938g, same-origin, covered by
 * script-src 'self') and runs the config from bundled code, so no inline
 * <script> element exists. The CF-served gtag.js routes beacons first-party
 * (transport_url=/938g), covered by `connect-src 'self' https:`.
 *
 * Gated to the production host so preview (*.pages.dev) and localhost traffic
 * never reach the property. SPA route-change page_views ARE wired below: the
 * config uses send_page_view:false and a PII-safe page_view is fired manually
 * on init and on every hash/history route change. GA4 Enhanced Measurement only
 * auto-tracks History API navigations, not the hash changes a HashRouter SPA
 * emits, so without this the entire session would report a single page_view.
 *
 * Consent is REGION-SCOPED: analytics_storage is granted by default for
 * rest-of-world (so GA4 reports populate) and denied for the EEA/UK/CH region
 * (cookieless until opt-in). gtag.js resolves the region from Google's IP-geo,
 * so no server-side lookup is needed. The bundled consent banner
 * (mountConsentBanner) lets a visitor grant/revoke; the choice is persisted in
 * localStorage and re-applied on return, overriding the regional default.
 */
import { mountConsentBanner } from './consentBanner'

const GA4_MEASUREMENT_ID = 'G-NG9YX5G9CM'
const GA4_HOST = 'swap.ophis.fi'

// EEA member states + UK + Switzerland — kept cookieless until the visitor
// opts in, for GDPR/ePrivacy compliance. Shared with the consent banner copy.
export const EEA_CONSENT_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
  'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
]

export function initGa4(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.location.hostname !== GA4_HOST) return
  // Idempotent: never inject twice (HMR / re-entry).
  if (document.getElementById('ophis-ga4')) return

  const w = window as unknown as { dataLayer: unknown[]; gtag: (...args: unknown[]) => void }
  w.dataLayer = w.dataLayer || []
  // Match Google's canonical gtag exactly: push the live `arguments` object.
  // gtag.js recognises an arguments-object push as a command; a copied rest
  // array is not processed identically.
  // eslint-disable-next-line prefer-rest-params
  w.gtag = function gtag(): void {
    w.dataLayer.push(arguments)
  }

  // Consent Mode v2, REGION-SCOPED. All consent defaults MUST be queued before
  // config so GA never sets cookies pre-consent.
  // Global default: ads denied, analytics granted (ROW measured).
  w.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  })
  // EEA/UK/CH override: cookieless until the visitor opts in via the banner.
  w.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    region: EEA_CONSENT_REGIONS,
    wait_for_update: 500,
  })
  // Re-apply a returning visitor's explicit choice (overrides the regional default).
  try {
    const saved = localStorage.getItem('ophis_consent')
    if (saved === 'granted' || saved === 'denied') {
      w.gtag('consent', 'update', { analytics_storage: saved })
    }
  } catch {
    /* localStorage blocked: keep the regional default */
  }

  // Perf: defer ONLY the ~506KB gtag.js download off the critical boot path
  // (post-FCP). The window.gtag shim + dataLayer + consent commands above already
  // ran synchronously, so the gtag('js'/'config') + page_view commands below, plus
  // any early trackGa4Event() calls, queue into window.dataLayer and are drained in
  // FIFO order once gtag.js loads. No analytics lost; only the script timing moves.
  const injectGtag = (): void => {
    if (document.getElementById('ophis-ga4')) return
    const script = document.createElement('script')
    script.id = 'ophis-ga4'
    script.async = true
    // First-party via Cloudflare Google Tag Gateway (endpoint /938g on the ophis.fi
    // zone). Same-origin path -> https://swap.ophis.fi/938g/...; the CF-served
    // gtag.js carries transport_url=/938g so beacons are first-party too (beats
    // ad-blockers). Covered by script-src 'self'; connect-src 'self' covers beacons.
    script.src = `/938g/gtag/js?id=${GA4_MEASUREMENT_ID}`
    document.head.appendChild(script)
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(injectGtag, { timeout: 3000 })
  } else {
    window.addEventListener('load', () => window.setTimeout(injectGtag, 1), { once: true })
  }

  w.gtag('js', new Date())
  // send_page_view:false: this is a HashRouter SPA, so page_view is sent
  // manually (initial + per route change) by trackSpaPageViews below. The
  // default single auto page_view would undercount the whole session to one view.
  w.gtag('config', GA4_MEASUREMENT_ID, { anonymize_ip: true, send_page_view: false })

  trackSpaPageViews(w.gtag)

  // Show the opt-in/opt-out banner (no-op once the visitor has chosen).
  mountConsentBanner()
}

// Collapse 0x-addresses (wallet/token/proxy) to a placeholder so page paths
// aggregate by route template and no address is ever sent to GA4.
function sanitizePath(pathAndHash: string): string {
  return pathAndHash.replace(/0x[a-fA-F0-9]{40}/g, '0x_addr')
}

// Fire a PII-safe GA4 page_view on init and on every SPA route change.
// HashRouter route changes emit `hashchange`; back/forward emit `popstate`.
function trackSpaPageViews(gtag: (...args: unknown[]) => void): void {
  let lastPath = ''
  const send = (): void => {
    const path = sanitizePath(location.pathname + location.hash)
    if (path === lastPath) return
    lastPath = path
    gtag('event', 'page_view', {
      page_path: path,
      page_location: location.origin + path,
      page_title: document.title,
    })
  }
  send() // initial view (config no longer auto-sends it)
  window.addEventListener('hashchange', send)
  window.addEventListener('popstate', send)
}
