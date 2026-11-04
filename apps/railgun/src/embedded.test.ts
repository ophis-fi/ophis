import { afterEach, expect, it, vi } from 'vitest'
import { reportEmbeddedLayout } from './embedded'

afterEach(() => vi.unstubAllGlobals())

it.each([1000, 600, 390])('fits an open wallet dialog inside the %s px host viewport and restores the full page height', (height) => {
  const message = vi.fn(), observers: (() => void)[] = []
  let open = true
  vi.stubGlobal('window', { parent: { innerHeight: height, postMessage: message }, addEventListener: vi.fn() })
  vi.stubGlobal('location', { origin: 'https://swap.ophis.fi' })
  vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelector: (selector: string) =>
    selector === 'main' ? { getBoundingClientRect: () => ({ height: 2500 }) } : open ? { scrollHeight: 620 } : null })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback())
  const Observer = class { constructor(callback: () => void) { observers.push(callback) } observe() {} }
  vi.stubGlobal('ResizeObserver', Observer); vi.stubGlobal('MutationObserver', Observer)
  reportEmbeddedLayout()
  expect(message).toHaveBeenCalled()
  expect(message.mock.lastCall?.[0].height).toBeGreaterThanOrEqual(240)
  expect(message.mock.lastCall?.[0].height).toBeLessThan(height)
  open = false; observers[1]()
  expect(message.mock.lastCall?.[0].height).toBe(2500)
})
