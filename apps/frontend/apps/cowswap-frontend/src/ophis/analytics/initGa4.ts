/**
 * Google Analytics 4 (gtag) bootstrap for the Ophis swap app.
 *
 * Why a bundled module instead of the standard inline snippet: the swap app
 * deploys to Cloudflare Pages under a strict CSP (public/_headers) with NO
 * 'unsafe-inline' in script-src, so an inline gtag bootstrap would be blocked.
 * This module is part of the 'self' bundle; it injects the external gtag.js
 * (allowed via the https://www.googletagmanager.com entry in script-src) and
 * runs the config from bundled code, so no inline <script> element exists.
 * Beacons to *.google-analytics.com are covered by `connect-src 'self' https:`.
 *
 * Gated to the production host so preview (*.pages.dev) and localhost traffic
 * never reach the property. SPA route-change page_views are not yet wired (the
 * gtag('config') call sends the initial page_view); add that as a follow-up if
 * per-route analytics are needed.
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

  const script = document.createElement('script')
  script.id = 'ophis-ga4'
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`
  document.head.appendChild(script)

  w.gtag('js', new Date())
  w.gtag('config', GA4_MEASUREMENT_ID, { anonymize_ip: true })

  // Show the opt-in/opt-out banner (no-op once the visitor has chosen).
  mountConsentBanner()
}
