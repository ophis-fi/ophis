import { assertOtcRuntimeControl, readOtcRuntimeControl } from './otcRuntimeControl'

const originalFetch = global.fetch
const fetchMock = jest.fn()

beforeEach(() => {
  jest.useFakeTimers()
  fetchMock.mockReset()
  global.fetch = fetchMock
})

afterEach(() => {
  global.fetch = originalFetch
  jest.clearAllTimers()
  jest.useRealTimers()
})

function respond(enabled: unknown, staleNonce?: string): void {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      enabled,
      nonce: staleNonce ?? new URL(url, 'https://swap.ophis.fi').searchParams.get('nonce'),
    }),
  }))
}

it('requires a fresh literal permission and requests uncached responses', async () => {
  respond(true)
  await expect(assertOtcRuntimeControl()).resolves.toBeUndefined()
  await expect(readOtcRuntimeControl()).resolves.toBe(true)
  expect(fetchMock.mock.calls[0][0]).not.toBe(fetchMock.mock.calls[1][0])
  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: 'no-store' }))
  respond(false)
  await expect(assertOtcRuntimeControl()).rejects.toThrow('writes are disabled')
})

it.each([false, undefined, 'true', 1])('rejects non-permission %s', async (value) => {
  respond(value)
  await expect(readOtcRuntimeControl()).resolves.toBe(false)
})

it('rejects cached permission for another request and failed provider responses', async () => {
  respond(true, 'a'.repeat(32))
  await expect(readOtcRuntimeControl()).resolves.toBe(false)
  fetchMock.mockResolvedValue({ ok: false })
  await expect(readOtcRuntimeControl()).resolves.toBe(false)
  fetchMock.mockRejectedValue(new Error('offline'))
  await expect(assertOtcRuntimeControl()).rejects.toThrow('offline')
})

it.each(['headers', 'body'])('bounds stalled response %s', async (part) => {
  const stalled = new Promise<never>(() => undefined)
  fetchMock.mockImplementation(() =>
    part === 'headers' ? stalled : Promise.resolve({ ok: true, json: () => stalled }),
  )
  const result = expect(readOtcRuntimeControl()).rejects.toThrow('Ophis OTC runtime control')
  await jest.advanceTimersByTimeAsync(4_001)
  await result
})
