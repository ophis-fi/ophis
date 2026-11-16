import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the pinned, patched SDK, replacing only its network boundary.
const require = createRequire(import.meta.url)
const dist = dirname(require.resolve('@railgun-community/waku-broadcaster-client-web'))
const { WakuBroadcasterClient: client } = await import(pathToFileURL(join(dist, 'waku-broadcaster-client.js')).href)
const { WakuBroadcasterWakuCore: core } = await import(pathToFileURL(join(dist, 'waku/waku-broadcaster-waku-core.js')).href)
const { WakuObservers: observers } = await import(pathToFileURL(join(dist, 'waku/waku-observers.js')).href)
const { BroadcasterConfig: routing } = await import(pathToFileURL(join(dist, 'models/broadcaster-config.js')).href)
const sdkRequire = createRequire(join(dist, '../package.json'))
// @waku/sdk exposes an import-only entry. Use the Railgun package's dependency
// lookup paths to locate its installed internal classes without absolute paths.
const sdkPackage = sdkRequire.resolve.paths('@waku/sdk')?.map(path => join(path, '@waku/sdk'))
  .find(path => existsSync(join(path, 'package.json')))
if (!sdkPackage) throw new Error('The pinned Railgun Waku SDK dependency is unavailable.')
const sdkDist = join(sdkPackage, 'dist')
const { Filter } = await import(pathToFileURL(join(sdkDist, 'filter/filter.js')).href)
const { Subscription } = await import(pathToFileURL(join(sdkDist, 'filter/subscription.js')).href)
const topic = 'ophis-test-transport'
const subscriptions: { disposeHandlers(): void; receivedMessages: { dispose(): void } }[] = []
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) { subscription.disposeHandlers(); subscription.receivedMessages.dispose() }
  core.waku = undefined; observers.currentSubscriptions = []; observers.currentContentTopics = []; vi.restoreAllMocks()
})

it.each([{}, { successes: [] }, { recipients: [] }, { successes: [], failures: [] },
  { successes: [], failures: [{ error: 'peer refused' }] }])('rejects an unacknowledged publication: %j', async result => {
  core.waku = { lightPush: { send: vi.fn().mockResolvedValue(result) } }
  await expect(client.sendTransport({ fixture: true }, topic)).rejects.toThrow('delivery was not confirmed')
  expect(core.waku.lightPush.send).toHaveBeenCalledTimes(1)
})

it.each([{ successes: ['peer'] }, { recipients: ['peer'] }, { successes: ['peer'], failures: [{ error: 'other peer' }] }])
('accepts a publication acknowledged by at least one peer: %j', async result => {
  core.waku = { lightPush: { send: vi.fn().mockResolvedValue(result) } }
  await expect(client.sendTransport({ fixture: true }, topic)).resolves.toBeUndefined()
})

it('propagates a send rejection without exposing its raw diagnostic or replaying', async () => {
  core.waku = { lightPush: { send: vi.fn().mockRejectedValue(new Error('sensitive synthetic diagnostic')) } }
  const error = await client.sendTransport({ fixture: true }, topic).catch((error: Error) => error)
  expect(error.message).toBe('Private broadcaster message delivery was not confirmed. Keep the saved attempt for recovery.')
  expect(core.waku.lightPush.send).toHaveBeenCalledTimes(1)
})

it('subscribes on the supplied node instead of a replacement global node', async () => {
  const supplied = { filter: { subscribe: vi.fn().mockResolvedValue(true), unsubscribe: vi.fn() } }
  core.waku = { filter: { subscribe: vi.fn().mockResolvedValue(true) } }
  await client.addTransportSubscription(supplied, topic, () => {})
  expect(supplied.filter.subscribe).toHaveBeenCalledTimes(1)
  expect(core.waku.filter.subscribe).not.toHaveBeenCalled()
  expect(client.getContentTopics()).toContain(`/railgun/v2/encrypted-${topic}/json`)
})

it('refuses a missing response transport', async () => {
  await expect(client.addTransportSubscription(undefined, topic, () => {})).rejects.toThrow('subscription unavailable')
  expect(client.getContentTopics()).toEqual([])
})

// Use real Filter/Subscription state transitions, replacing only peer/protocol I/O.
// A pre-existing fee subscription avoids starting libp2p or background timers.
async function filterFixture(subscribeMode: 'refusal' | 'throw', cleanupMode: 'success' | 'refusal' | 'throw') {
  routing.configureWakuNetwork({ clusterId: 5, shardId: 1, pubSubTopic: '/waku/2/rs/5/1' })
  const pubsubTopic = '/waku/2/rs/5/1', response = `/railgun/v2/encrypted-${topic}/json`, fees = '/synthetic/fees'
  const requests: { method: string; topics: string[] }[] = []
  const peer = { toString: () => 'synthetic-peer' }
  let accepted = false
  const protocol = {
    subscribe: async (_pubsub: string, _peer: unknown, topics: string[]) => {
      requests.push({ method: 'subscribe', topics: [...topics] })
      if (topics.includes(response) && !accepted) {
        if (subscribeMode === 'throw') throw new Error('synthetic-subscription-failure')
        return { success: null, failure: { error: 'synthetic-refusal' } }
      }
      return { success: peer, failure: null }
    },
    unsubscribe: async (_pubsub: string, _peer: unknown, topics: string[]) => {
      requests.push({ method: 'unsubscribe', topics: [...topics] })
      if (cleanupMode === 'throw') throw new Error('synthetic-cleanup-failure')
      return cleanupMode === 'refusal' ? { success: null, failure: { error: 'synthetic-refusal' } }
        : { success: peer, failure: null }
    },
  }
  const config = { numPeersToUse: 2, pingsBeforePeerRenewed: 3, keepAliveIntervalMs: 60_000 }
  const peerManager = { getPeers: async () => [peer] }
  const subscription = new Subscription({ pubsubTopic, protocol, config, peerManager })
  subscriptions.push(subscription)
  const filter = Object.assign(Object.create(Filter.prototype), {
    protocol, config, peerManager, subscriptions: new Map([[pubsubTopic, subscription]]),
  })
  await filter.subscribe({ contentTopic: fees, pubsubTopic }, () => {})
  return { node: { filter }, subscription, requests, response, fees,
    accept: () => { accepted = true },
    attempts: () => requests.filter(request => request.method === 'subscribe' && request.topics.includes(response)).length }
}

it.each([['refusal', 'success'], ['refusal', 'refusal'], ['throw', 'success']] as const)
('retries a real peer subscription after %s and exact decoder cleanup %s', async (subscribeMode, cleanupMode) => {
  const f = await filterFixture(subscribeMode, cleanupMode)
  await expect(client.addTransportSubscription(f.node, topic, () => {})).rejects.toThrow('response subscription failed')
  expect(f.attempts()).toBe(1)
  expect(client.getContentTopics()).not.toContain(f.response)
  expect(observers.currentSubscriptions).toHaveLength(0)
  expect(f.subscription.contentTopics).toEqual([f.fees])
  expect(f.subscription.peers.size).toBe(0)
  expect(f.requests.filter(request => request.method === 'unsubscribe')).toEqual([])
  f.accept()
  await client.addTransportSubscription(f.node, topic, () => {})
  expect(f.attempts()).toBe(2)
  expect(f.subscription.callbacks.size).toBe(2)
  expect(f.subscription.toUnsubscribeContentTopics.size).toBe(0)
  expect(client.getContentTopics()).toEqual([f.response])
  expect(observers.currentSubscriptions).toHaveLength(1)
})

it('quarantines the exact core after cleanup throws and subscribes successfully on a fresh core', async () => {
  const old = await filterFixture('refusal', 'throw')
  const remove = old.node.filter.unsubscribe.bind(old.node.filter)
  old.node.filter.unsubscribe = async (decoder: unknown) => { await remove(decoder); throw new Error('synthetic-local-cleanup-failure') }
  await expect(client.addTransportSubscription(old.node, topic, () => {})).rejects.toThrow('response subscription failed')
  old.accept()
  await expect(client.addTransportSubscription(old.node, topic, () => {})).rejects.toThrow('subscription unavailable')
  expect(old.attempts()).toBe(1)
  expect(old.subscription.callbacks.size).toBe(1)
  expect(client.getContentTopics()).toEqual([])
  const fresh = await filterFixture('refusal', 'success'); fresh.accept()
  await client.addTransportSubscription(fresh.node, topic, () => {})
  expect(fresh.attempts()).toBe(1)
  expect(fresh.subscription.toUnsubscribeContentTopics.size).toBe(0)
  expect(client.getContentTopics()).toEqual([fresh.response])
})

async function churnFixture() {
  const pubsubTopic = '/waku/2/rs/5/1', fees = '/synthetic/fees', response = `/railgun/v2/encrypted-${topic}/json`
  routing.configureWakuNetwork({ clusterId: 5, shardId: 1, pubSubTopic: pubsubTopic })
  const a = { toString: () => 'a' }, b = { toString: () => 'b' }
  let available = [a, b], refuse = true
  const protocol = {
    subscribe: vi.fn(async (_pubsub: string, peer: typeof a, topics: string[]) =>
      peer === b && topics.includes(response) && refuse
        ? { success: null, failure: { error: 'synthetic refusal' } } : { success: peer, failure: null }),
    unsubscribe: async () => ({ success: b, failure: null }),
  }
  const peerManager = { getPeers: async () => available, isPeerOnPubsub: async () => true }
  const config = { numPeersToUse: 2, pingsBeforePeerRenewed: 3, keepAliveIntervalMs: 60_000 }
  const subscription = new Subscription({ pubsubTopic, protocol, peerManager, config })
  subscriptions.push(subscription)
  const filter = Object.assign(Object.create(Filter.prototype), { protocol, peerManager, config,
    subscriptions: new Map([[pubsubTopic, subscription]]) })
  const decoder = (contentTopic: string) => ({ contentTopic, pubsubTopic })
  await filter.subscribe(decoder(fees), () => {})
  await client.addTransportSubscription({ filter }, topic, () => {})
  return { a, b, subscription, protocol, filter, decoder, fees, response,
    available: (peers: typeof a[]) => { available = peers }, accept: () => { refuse = false },
    disconnected: async () => { await subscription.onPeerDisconnected({ detail: a }); await new Promise(resolve => setImmediate(resolve)) } }
}

it('restores every response topic through the previously refusing peer after peer loss', async () => {
  const f = await churnFixture()
  expect([...f.subscription.peers.keys()]).toEqual(['a'])
  f.available([f.b]); f.accept(); await f.disconnected()
  expect([...f.subscription.peers.keys()]).toEqual(['b'])
  expect(f.protocol.subscribe.mock.calls.at(-1)![2].sort()).toEqual([f.fees, f.response].sort())
  expect(f.subscription.toSubscribeContentTopics.size).toBe(0)
  expect(f.subscription.callbacks.size).toBe(2)
})

it('keeps retry intent when the last peer disappears before replacement discovery', async () => {
  const f = await churnFixture()
  f.available([]); await f.disconnected()
  expect(f.subscription.peers.size).toBe(0)
  expect([...f.subscription.toSubscribeContentTopics].sort()).toEqual([f.fees, f.response].sort())
  f.available([f.b]); f.accept()
  await expect(f.subscription.attemptSubscribe({ useNewContentTopics: true })).resolves.toBe(true)
  expect([...f.subscription.peers.keys()]).toEqual(['b'])
  expect(f.subscription.toSubscribeContentTopics.size).toBe(0)
})

it.each([true, false])('retains retry intent after concurrent success and failure, success last: %s', async successLast => {
  const f = await churnFixture(); f.available([f.a])
  const releases: ((value: Awaited<ReturnType<typeof f.protocol.subscribe>>) => void)[] = []
  f.protocol.subscribe.mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
  const first = f.subscription.attemptSubscribe({ useNewContentTopics: false })
  const second = f.subscription.attemptSubscribe({ useNewContentTopics: false })
  await vi.waitFor(() => expect(releases).toHaveLength(2))
  const success = { success: f.a, failure: null }, refused = { success: null, failure: { error: 'refused' } }
  releases[1](successLast ? refused : success); await second
  releases[0](successLast ? success : refused); await first
  expect(f.subscription.peers.size).toBe(0)
  expect([...f.subscription.toSubscribeContentTopics].sort()).toEqual([f.fees, f.response].sort())
  f.protocol.subscribe.mockResolvedValue({ success: f.a, failure: null })
  await expect(f.subscription.attemptSubscribe({ useNewContentTopics: true })).resolves.toBe(true)
  expect([...f.subscription.peers.keys()]).toEqual(['a'])
  expect(f.subscription.toSubscribeContentTopics.size).toBe(0)
})

it('does not erase a newer failed topic when an older subscription succeeds', async () => {
  const f = await churnFixture(); f.available([f.a])
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  f.protocol.subscribe.mockImplementation(async (_pubsub, _peer, topics) => {
    if (topics.includes('/synthetic/new')) return { success: null, failure: { error: 'refused' } }
    await waiting; return { success: f.a, failure: null }
  })
  const older = f.subscription.attemptSubscribe({ useNewContentTopics: false })
  await vi.waitFor(() => expect(f.protocol.subscribe).toHaveBeenCalledTimes(5))
  await expect(f.filter.subscribe(f.decoder('/synthetic/new'), () => {})).resolves.toBe(false)
  release(); await older
  expect(f.subscription.toSubscribeContentTopics.has('/synthetic/new')).toBe(true)
})
