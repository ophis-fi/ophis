import { mountConsentBanner } from './consentBanner'

const trackedWindow = window as unknown as { gtag?: (...args: unknown[]) => void }

afterEach(() => {
  document.getElementById('ophis-consent')?.remove()
  localStorage.removeItem('ophis_consent')
  delete trackedWindow.gtag
})

it('preserves a saved choice until a reopened preferences banner receives a new choice', () => {
  localStorage.setItem('ophis_consent', 'denied')
  trackedWindow.gtag = jest.fn()
  mountConsentBanner()
  expect(document.getElementById('ophis-consent')).toBeNull()

  mountConsentBanner(true)
  document.dispatchEvent(new Event('DOMContentLoaded'))
  expect(localStorage.getItem('ophis_consent')).toBe('denied')
  expect(trackedWindow.gtag).not.toHaveBeenCalled()
  const accept = Array.from(document.querySelectorAll<HTMLButtonElement>('#ophis-consent button')).find(
    (button) => button.textContent === 'Accept',
  )
  expect(accept).toBeDefined()
  accept?.click()
  expect(localStorage.getItem('ophis_consent')).toBe('granted')
  expect(trackedWindow.gtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'granted' })
  expect(document.getElementById('ophis-consent')).toBeNull()
})
