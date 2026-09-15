const mockTrack = jest.fn()
const mockInit = jest.fn()
jest.mock('./track', () => ({ trackGa4Event: mockTrack }))
jest.mock('./initGa4', () => ({ initGa4: mockInit }))

beforeEach(() => {
  jest.resetModules()
  jest.useFakeTimers()
  mockTrack.mockClear()
  mockInit.mockClear()
  window.history.replaceState({}, '', '/')
  document.body.innerHTML = '<a data-trade-cta href="/#/4663/swap">Trade</a>'
})
afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})

it.each(['callback', 'timeout'])('navigates on the analytics %s instead of discarding the event immediately', async (mode) => {
  await import('./tradeGuide.service')
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  document.querySelector('a')?.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(window.location.hash).toBe('')
  expect(mockInit).toHaveBeenCalledWith({ deferDownload: false })
  expect(mockTrack).toHaveBeenCalledWith('trade_click', expect.objectContaining({
    destination: 'swap_app', chainId: 4663, event_timeout: 1000,
  }))
  if (mode === 'callback') mockTrack.mock.calls[0][1].event_callback()
  else jest.advanceTimersByTime(1000)
  expect(window.location.hash).toBe('#/4663/swap')
})

it('preserves modified-click browser behavior', async () => {
  await import('./tradeGuide.service')
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
  document.querySelector('a')?.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(mockTrack).not.toHaveBeenCalled()
})
