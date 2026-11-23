/** @jest-environment jsdom */
import { shouldRetryChunkLoad } from './chunkLoadRecovery.utils'

describe('chunk load recovery', () => {
  beforeEach(() => {
    document.head.innerHTML = '<script type="module" src="/static/app-first.js"></script>'
    sessionStorage.clear()
  })

  afterEach(() => jest.restoreAllMocks())

  it('retries once per build in a tab', () => {
    expect(shouldRetryChunkLoad()).toBe(true)
    expect(shouldRetryChunkLoad()).toBe(false)
    document.head.innerHTML = '<script type="module" src="/static/app-next.js"></script>'
    expect(shouldRetryChunkLoad()).toBe(true)
  })

  it('preserves the manual fallback offline or when storage cannot record the retry', () => {
    const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(shouldRetryChunkLoad()).toBe(false)
    online.mockRestore()
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    expect(shouldRetryChunkLoad()).toBe(false)
  })
})
