/**
 * Opt-in/opt-out analytics consent banner for swap.ophis.fi.
 *
 * Bundled (not inline) because the swap app ships a strict CSP with no
 * 'unsafe-inline' in script-src — an inline banner script would be blocked.
 * This module is part of the 'self' bundle and builds the banner via DOM APIs
 * (no innerHTML event handlers), so it stays CSP-clean. Inline element styles
 * are fine: the CSP allows 'unsafe-inline' in style-src.
 *
 * Pairs with the region-scoped Consent Mode defaults in initGa4.ts: it upgrades
 * or revokes analytics_storage and persists the choice in localStorage under
 * `ophis_consent` (the same key initGa4 re-applies on return).
 */
type Consent = 'granted' | 'denied'

const STORAGE_KEY = 'ophis_consent'
const BANNER_ID = 'ophis-consent'
const SAFFRON = '#f2a63e'

function applyConsent(value: Consent): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* localStorage blocked: still apply to the live tag */
  }
  const w = window as unknown as { gtag?: (...args: unknown[]) => void }
  w.gtag?.('consent', 'update', { analytics_storage: value })
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

export function mountConsentBanner(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(BANNER_ID)) return
  let stored: string | null = null
  try {
    stored = localStorage.getItem(STORAGE_KEY)
  } catch {
    /* localStorage blocked: show the banner so the visitor can choose */
  }
  if (stored === 'granted' || stored === 'denied') return

  const render = (): void => {
    if (document.getElementById(BANNER_ID) || !document.body) return

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
    link.href = '/#/legal'
    link.textContent = 'Learn more'
    link.style.cssText = `color:${SAFFRON};text-decoration:underline`
    txt.appendChild(link)
    txt.appendChild(document.createTextNode('.'))

    const dismiss = (): void => bar.remove()
    bar.appendChild(txt)
    bar.appendChild(makeButton('Decline', 'denied', false, dismiss))
    bar.appendChild(makeButton('Accept', 'granted', true, dismiss))
    document.body.appendChild(bar)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render)
  } else {
    render()
  }
}
