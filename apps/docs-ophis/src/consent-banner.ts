/**
 * Opt-in/opt-out analytics consent banner for docs.ophis.fi.
 *
 * Loaded as a Docusaurus `clientModule` (see docusaurus.config.ts). The
 * region-scoped Consent Mode defaults are set in the headTags inline bootstrap;
 * this module renders the banner that lets a visitor grant or revoke
 * analytics_storage and persists the choice in localStorage under
 * `ophis_consent` (the same key the inline bootstrap re-applies on return).
 *
 * SSR-safe: Docusaurus imports client modules during the static build, so all
 * DOM work is guarded behind a `document` check and runs only in the browser.
 */
type Consent = 'granted' | 'denied'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

const STORAGE_KEY = 'ophis_consent'
const BANNER_ID = 'ophis-consent'
const SAFFRON = '#f2a63e'

function applyConsent(value: Consent): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* localStorage blocked: still apply to the live tag */
  }
  window.gtag?.('consent', 'update', { analytics_storage: value })
}

function makeButton(label: string, value: Consent, primary: boolean, onDone: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.style.cssText =
    'cursor:pointer;border-radius:9px;padding:8px 16px;font:600 14px system-ui,sans-serif;border:1px solid ' +
    (primary ? SAFFRON : 'rgba(255,255,255,.22)') +
    ';background:' +
    (primary ? SAFFRON : 'transparent') +
    ';color:' +
    (primary ? '#0a0a0a' : '#e8e8e8')
  b.addEventListener('click', () => {
    applyConsent(value)
    onDone()
  })
  return b
}

function mountBanner(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(BANNER_ID)) return
  let stored: string | null = null
  try {
    stored = localStorage.getItem(STORAGE_KEY)
  } catch {
    /* localStorage blocked: show the banner so the visitor can choose */
  }
  if (stored === 'granted' || stored === 'denied') return

  const bar = document.createElement('div')
  bar.id = BANNER_ID
  bar.setAttribute('role', 'dialog')
  bar.setAttribute('aria-label', 'Analytics consent')
  bar.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;width:max-content;max-width:calc(100vw - 24px);display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center;padding:12px 16px;border:1px solid rgba(242,166,62,.28);border-radius:14px;background:rgba(10,10,10,.92);backdrop-filter:blur(8px);color:#e8e8e8;font:14px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)'

  const txt = document.createElement('span')
  txt.style.cssText = 'flex:1 1 240px;min-width:200px'
  txt.appendChild(document.createTextNode('We use privacy-respecting analytics (anonymized IP, no ads). '))
  const link = document.createElement('a')
  link.href = 'https://swap.ophis.fi/#/legal'
  link.textContent = 'Learn more'
  link.style.cssText = `color:${SAFFRON};text-decoration:underline`
  txt.appendChild(link)
  txt.appendChild(document.createTextNode('.'))

  const dismiss = () => bar.remove()
  bar.appendChild(txt)
  bar.appendChild(makeButton('Decline', 'denied', false, dismiss))
  bar.appendChild(makeButton('Accept', 'granted', true, dismiss))
  document.body.appendChild(bar)
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBanner)
  } else {
    mountBanner()
  }
}

export {}
