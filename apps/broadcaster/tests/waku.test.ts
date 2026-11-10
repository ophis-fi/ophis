import { afterEach, expect, it, vi } from 'vitest'
import { CHAIN_ID, MAX_MESSAGE_BYTES, TOPICS } from '../src/config'
import { creditTopics, encryptedCreditTopic } from '../../railgun/credit-protocol'
import { boundedJSON, WakuRelay } from '../src/waku'

afterEach(() => vi.unstubAllGlobals())
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

it('counts full upstream caches before filtering other topics and keeps the warning across later empty polls', async () => {
  const waku = relay(Array.from({ length: 16 }, () => entry('other-chain', '/railgun/v2/other-transact/json')))
  expect(await waku.messages()).toEqual([])
  vi.mocked(fetch).mockResolvedValueOnce(new Response('[]'))
  expect(await waku.messages()).toEqual([])
  expect(waku.saturated).toBe(true)
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
