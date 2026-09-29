import { enrollOphisTrader } from './enrollOphisTrader'

const originalFetch = global.fetch
const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
const owner = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  jest.useFakeTimers()
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
  fetchMock.mockReset().mockResolvedValue({ ok: true } as Response)
  global.fetch = fetchMock
})

afterEach(() => {
  global.fetch = originalFetch
  if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
  jest.clearAllTimers()
  jest.useRealTimers()
})

it('enrolls and renews without AbortSignal.timeout', async () => {
  expect(await enrollOphisTrader(owner)).toBe(true)
  expect(fetchMock).toHaveBeenCalledWith(`https://rebates.ophis.fi/tier/${owner}`, {
    signal: expect.any(AbortSignal),
  })
  expect(await enrollOphisTrader(owner)).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('aborts stalled enrollment and permits a later retry without AbortSignal.timeout', async () => {
  fetchMock.mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  const enrollment = enrollOphisTrader(owner)
  await jest.advanceTimersByTimeAsync(5000)
  expect(await enrollment).toBe(false)
  expect(await enrollOphisTrader(owner)).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
