import { mountConsentBanner } from './consentBanner'
import { initGa4 } from './initGa4'
import { trackGa4Event } from './track'

initGa4()
document.getElementById('analytics-preferences')?.addEventListener('click', () => mountConsentBanner(true))
document.querySelectorAll('[data-trade-cta]').forEach((link) => {
  link.addEventListener('click', () => trackGa4Event('trade_click', { destination: 'swap_app', chainId: 4663 }))
})
