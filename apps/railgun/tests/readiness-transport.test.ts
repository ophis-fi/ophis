import { afterEach, expect, it, vi } from 'vitest'
import { FetchRequest } from 'ethers'
import { configureReadinessTransport, type ThrottleSample } from './readiness-transport'

afterEach(() => vi.useRealTimers())

function probe(statuses: number[], headers: Record<string, string> = {}, error = 'limited', latency = 0) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'))
  const transport = new FetchRequest('https://example.invalid/private-provider-key')
  const throttles: ThrottleSample[] = [], sent: number[] = []
  transport.getUrlFunc = vi.fn(async () => {
    sent.push(Date.now())
    if (latency) await new Promise(resolve => setTimeout(resolve, latency))
    return { statusCode: statuses.shift() ?? 429, statusMessage: '', headers,
      body: Buffer.from(JSON.stringify({ error })) }
  })
  configureReadinessTransport(transport, throttles)
  return { transport, throttles, sent }
}

it('waits before each retry and succeeds after a transient shared rate limit', async () => {
  const { transport, throttles, sent } = probe([429, 429, 200], {}, 'Alchemy shared request rate reached.')
  const result = transport.send()
  await vi.runAllTimersAsync()
  expect((await result).statusCode).toBe(200)
  expect(sent.map(time => time - sent[0])).toEqual([0, 2000, 6000])
  expect(throttles).toEqual([
    { attempt: 1, reason: 'shared-provider-rate', retryInMs: 2000 },
    { attempt: 2, reason: 'shared-provider-rate', retryInMs: 4000 },
  ])
})

it('leaves a persistent failure visible after four attempts', async () => {
  const { transport, throttles, sent } = probe([429])
  const result = transport.send()
  await vi.runAllTimersAsync()
  expect((await result).statusCode).toBe(429)
  expect(sent.map(time => time - sent[0])).toEqual([0, 2000, 6000, 14000])
  expect(throttles.at(-1)?.retryInMs).toBeNull()
  expect(JSON.stringify(throttles)).not.toContain('private-provider-key')
})

it.each(['seconds', 'date'] as const)('honors Retry-After %s exactly once', async (format) => {
  const headers: Record<string, string> = {}
  const { transport, sent, throttles } = probe([429, 200], headers)
  headers['retry-after'] = format === 'seconds' ? '3' : new Date(Date.now() + 5000).toUTCString()
  const expected = format === 'seconds' ? 3000 : 5000
  const result = transport.send()
  await vi.runAllTimersAsync()
  expect((await result).statusCode).toBe(200)
  expect(sent[1] - sent[0]).toBe(expected)
  expect(throttles[0].retryInMs).toBe(expected)
})

it('keeps a late 429 visible without scheduling a retry past the per-send deadline', async () => {
  const { transport, sent, throttles } = probe([429, 200], {}, 'limited', 19_000)
  const start = Date.now(), result = transport.send()
  await vi.runAllTimersAsync()
  expect((await result).statusCode).toBe(429)
  expect(Date.now() - start).toBe(19_000)
  expect(sent).toHaveLength(1)
  expect(throttles).toEqual([{ attempt: 1, reason: 'http-429', retryInMs: null }])
})

it.each([
  [401, {}, 'unauthorized'],
  [503, {}, 'unavailable'],
  [429, { 'retry-after': '60' }, 'limited'],
  [429, { 'retry-after': '9'.repeat(400) }, 'limited'],
  [429, {}, 'Validation Cloud shared CU budget reached.'],
] as const)('does not retry a permanent error or a wait outside its budget (%s)', async (status, headers, error) => {
  const { transport, sent } = probe([status], headers, error)
  const result = transport.send()
  await vi.runAllTimersAsync()
  expect((await result).statusCode).toBe(status)
  expect(sent).toHaveLength(1)
})
