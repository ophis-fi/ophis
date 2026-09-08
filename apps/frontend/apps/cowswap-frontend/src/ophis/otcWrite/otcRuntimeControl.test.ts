import { assertOtcRuntimeControl, readOtcRuntimeControl } from './otcRuntimeControl'

const originalMode = process.env.REACT_APP_OTC_WRITE_MODE
const originalFetch = global.fetch
const fetchMock = jest.fn()

beforeEach(() => {
  process.env.REACT_APP_OTC_WRITE_MODE = 'public'
  jest.useFakeTimers()
  fetchMock.mockReset()
  global.fetch = fetchMock
})

afterEach(() => {
  if (originalMode === undefined) delete process.env.REACT_APP_OTC_WRITE_MODE
  else process.env.REACT_APP_OTC_WRITE_MODE = originalMode
  global.fetch = originalFetch
  jest.clearAllTimers()
  jest.useRealTimers()
})

function respond(enabled: unknown, staleNonce?: string, mode: unknown = process.env.REACT_APP_OTC_WRITE_MODE): void {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      enabled,
      mode,
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

it.each(['canary', 'public'])('%s requires matching control scope', async (mode) => {
  process.env.REACT_APP_OTC_WRITE_MODE = mode
  for (const supplied of ['canary', 'public', null, 'unknown']) {
    respond(true, undefined, supplied)
    await expect(readOtcRuntimeControl()).resolves.toBe(supplied === mode)
  }
})

it('rejects a legacy response without a mode', async () => {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({ enabled: true, nonce: new URL(url, 'https://swap.ophis.fi').searchParams.get('nonce') }),
  }))
  await expect(readOtcRuntimeControl()).resolves.toBe(false)
})
