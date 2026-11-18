import { afterEach, expect, it, vi } from 'vitest'
import { CHAIN_ID, MAX_MESSAGE_BYTES, TOPICS } from '../src/config'
import { creditTopics, encryptedCreditTopic } from '../../railgun/credit-protocol'
import { boundedJSON, WakuRelay } from '../src/waku'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const entry = (payload: Uint8Array | string, contentTopic = TOPICS.transact) => ({
  contentTopic, payload: Buffer.from(payload).toString('base64'),
})
const relay = (body: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
  return new WakuRelay('http://127.0.0.1:8645')
}

it('routes prepaid replies to their encrypted chain topic without mixing legacy or other-chain requests', async () => {
  const topics = creditTopics(CHAIN_ID), other = creditTopics(CHAIN_ID === 1 ? 56 : 1)
  const waku = relay([entry('prepaid', encryptedCreditTopic(topics.request)), entry('legacy'),
    entry('other-chain', encryptedCreditTopic(other.request)), entry('response', encryptedCreditTopic(topics.response))])
  expect((await waku.messages()).map(({ payload, responseTopic }) => ({ body: Buffer.from(payload).toString(), responseTopic })))
    .toEqual([{ body: 'prepaid', responseTopic: encryptedCreditTopic(topics.response) }, { body: 'legacy', responseTopic: TOPICS.response }])
})

it('returns all 129 small payloads from a cleared relay batch and reports saturation', async () => {
  const expected = Array.from({ length: 129 }, (_, index) => String(index))
  const waku = relay(expected.map((payload) => entry(payload)))
  expect((await waku.messages()).map(({ payload }) => Buffer.from(payload).toString())).toEqual(expected)
  expect(waku.saturated).toBe(true)
})

it('accepts a configured full batch of 16 maximum-size payloads within the 16MiB response limit', async () => {
  const waku = relay(Array.from({ length: 16 }, () => entry(Buffer.alloc(MAX_MESSAGE_BYTES, 1))))
  const messages = await waku.messages()
  expect(messages).toHaveLength(16)
  expect(messages.every((message) => message.payload.length === MAX_MESSAGE_BYTES && message.payload[0] === 1)).toBe(true)
  expect(waku.saturated).toBe(true)
})

it('counts full caches before filtering and clears only after sustained successful polling', async () => {
  vi.useFakeTimers()
  const fullAt = Date.now()
  const waku = relay(Array.from({ length: 16 }, () => entry('other-chain', '/railgun/v2/other-transact/json')))
  expect(await waku.messages()).toEqual([])
  vi.mocked(fetch).mockImplementation(async () => new Response('[]'))
  expect(await waku.messages()).toEqual([])
  expect(waku.saturated).toBe(true)
  vi.advanceTimersByTime(120_000)
  await waku.messages()
  expect(waku.saturated).toBe(true)
  for (let elapsed = 5000; elapsed <= 60_000; elapsed += 5000) {
    vi.advanceTimersByTime(5000)
    await waku.messages()
    expect(waku.saturated).toBe(elapsed < 60_000)
  }
  expect(waku.fullBatches).toBe(1)
  expect(waku.lastFullBatchAt).toBe(fullAt)
})

it('restarts recovery after a failed poll or another full batch', async () => {
  vi.useFakeTimers()
  const waku = relay(Array.from({ length: 16 }, () => entry('full')))
  await waku.messages()
  vi.mocked(fetch).mockImplementation(async () => new Response('[]'))
  for (let poll = 0; poll < 12; poll++) {
    vi.advanceTimersByTime(5000)
    await waku.messages()
  }
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}'))
  await expect(waku.messages()).rejects.toThrow('invalid message list')
  vi.advanceTimersByTime(5000)
  await waku.messages()
  expect(waku.saturated).toBe(true)
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 16 }, () => entry('full again')))))
  await waku.messages()
  expect(waku.fullBatches).toBe(2)
  expect(waku.lastFullBatchAt).toBe(Date.now())
})

it('measures recovery with elapsed time even when the wall clock jumps forward', async () => {
  vi.useFakeTimers()
  const waku = relay(Array.from({ length: 16 }, () => entry('full')))
  await waku.messages()
  const fullAt = waku.lastFullBatchAt
  vi.mocked(fetch).mockImplementation(async () => new Response('[]'))
  await waku.messages()
  vi.setSystemTime(Date.now() + 4000)
  for (let seconds = 1; seconds <= 60; seconds++) {
    vi.advanceTimersByTime(1000)
    await waku.messages()
    expect(waku.saturated).toBe(seconds < 60)
  }
  expect(waku.lastFullBatchAt).toBe(fullAt)
})

it('filters unrelated topics and invalid or oversized individual payloads', async () => {
  const waku = relay([null, entry('other', TOPICS.response), { contentTopic: TOPICS.transact, payload: 7 },
    { contentTopic: TOPICS.transact, payload: '@invalid' }, entry(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), entry('accepted')])
  expect((await waku.messages()).map(({ payload }) => Buffer.from(payload).toString())).toEqual(['accepted'])
  expect(waku.saturated).toBe(false)
})

it.each([{}, null, 'not-an-array'])('rejects a malformed message list %s', async (body) => {
  await expect(relay(body).messages()).rejects.toThrow('invalid message list')
})

it('rejects oversized relay responses instead of treating a lost batch as empty', async () => {
  const waku = relay(Array.from({ length: 24 }, () => entry(Buffer.alloc(MAX_MESSAGE_BYTES))))
  await expect(waku.messages()).rejects.toThrow('size limit')
})

it('rejects invalid JSON and unsuccessful responses', async () => {
  await expect(boundedJSON(new Response('{broken'), 1024)).rejects.toThrow()
  await expect(boundedJSON(new Response('unavailable', { status: 503 }), 1024)).rejects.toThrow('Upstream request failed')
})

it('accepts the exact byte bound and cancels an oversized response reader', async () => {
  expect(await boundedJSON(new Response('[1]'), 3)).toEqual([1])
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('[1]')) }, cancel })
  await expect(boundedJSON(new Response(body), 2)).rejects.toThrow('size limit')
  expect(cancel).toHaveBeenCalledOnce()
})

it('rejects an oversized publication before sending anything', async () => {
  const waku = relay([])
  await expect(waku.publish(TOPICS.transact, Buffer.alloc(MAX_MESSAGE_BYTES + 1))).rejects.toThrow('size limit')
  expect(fetch).not.toHaveBeenCalled()
})

it('retries a saved reply and retains the remaining batch without running its handler twice', async () => {
  const waku = relay([entry('first'), entry('second')])
  const handle = vi.fn(async (payload: Uint8Array) => payload)
  const signal = new AbortController().signal
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([entry('first'), entry('second')])))
    .mockRejectedValueOnce(new Error('Publication failed'))
  await expect(waku.dispatch(handle, signal)).rejects.toThrow('Publication failed')
  expect(waku.pendingMessages).toBe(2)
  expect(handle).toHaveBeenCalledTimes(1)
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 200 }))
  await waku.dispatch(handle, signal)
  expect(waku.pendingMessages).toBe(0)
  expect(handle.mock.calls.map(([payload]) => Buffer.from(payload).toString())).toEqual(['first', 'second'])
  expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'POST', 'POST'])
})

it('retains a batch after handler failure and pauses delivery when stopping', async () => {
  const waku = relay([entry('first'), entry('second')])
  const abort = new AbortController()
  const handle = vi.fn<(payload: Uint8Array) => Promise<undefined>>().mockRejectedValueOnce(new Error('Handler failed'))
  await expect(waku.dispatch(handle, abort.signal)).rejects.toThrow('Handler failed')
  expect(waku.pendingMessages).toBe(2)
  abort.abort()
  await waku.dispatch(handle, abort.signal)
  expect(handle).toHaveBeenCalledTimes(1)
  handle.mockResolvedValue(undefined)
  await waku.dispatch(handle, new AbortController().signal)
  expect(handle.mock.calls.map(([payload]) => Buffer.from(payload).toString())).toEqual(['first', 'first', 'second'])
  expect(waku.pendingMessages).toBe(0)
  expect(fetch).toHaveBeenCalledOnce()
})

it('reports an oversized reply without allowing it to block the remaining batch or future intake', async () => {
  const waku = relay([entry('oversized-reply'), entry('sibling')])
  const handle = vi.fn<(payload: Uint8Array) => Promise<Uint8Array | undefined>>()
    .mockResolvedValueOnce(Buffer.alloc(MAX_MESSAGE_BYTES + 1)).mockResolvedValue(undefined)
  const signal = new AbortController().signal
  await expect(waku.dispatch(handle, signal)).rejects.toThrow('reply exceeds its size limit')
  expect(waku.pendingMessages).toBe(1)
  await waku.dispatch(handle, signal)
  expect(handle.mock.calls.map(([payload]) => Buffer.from(payload).toString())).toEqual(['oversized-reply', 'sibling'])
  expect(waku.pendingMessages).toBe(0)
  vi.mocked(fetch).mockResolvedValueOnce(new Response('[]'))
  await waku.dispatch(handle, signal)
  expect(fetch).toHaveBeenCalledTimes(2)
})
