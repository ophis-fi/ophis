import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = createRequire(import.meta.url)
const wallet = createRequire(root.resolve('@railgun-community/wallet'))
const cross = createRequire(wallet.resolve('@graphql-mesh/cross-helpers'))
const runtime = createRequire(wallet.resolve('@graphql-mesh/runtime'))
const validation = createRequire(runtime.resolve('@envelop/extended-validation'))

function manifest(loader, name) {
  const file = loader.resolve
    .paths(name)
    .map((base) => join(base, name, 'package.json'))
    .find(existsSync)
  if (!file) throw new Error(`Missing test dependency ${name}`)
  return realpathSync(file)
}
function childLoader(loader, name) {
  return createRequire(manifest(loader, name))
}
async function importDependency(loader, name, subpath = '.') {
  const file = manifest(loader, name)
  const entry = JSON.parse(readFileSync(file, 'utf8')).exports[subpath]
  return import(pathToFileURL(resolve(dirname(file), typeof entry === 'string' ? entry : entry.import)).href)
}

describe('browser dependency security backports', () => {
  it('preserves leading nonce bytes during RFC6979 truncation on P-521', () => {
    const engine = childLoader(root, '@railgun-community/engine')
    const circom = childLoader(engine, '@railgun-community/circomlibjs')
    const web3 = childLoader(circom, 'web3')
    const bzz = childLoader(web3, 'web3-bzz')
    const swarm = childLoader(bzz, 'swarm-js')
    const eth = childLoader(swarm, 'eth-lib')
    const elliptic = childLoader(eth, 'elliptic')
    const { ec: EC } = eth('elliptic')
    const BN = elliptic('bn.js')
    const DRBG = elliptic('hmac-drbg')
    const generate = DRBG.prototype.generate
    const bytes = Buffer.alloc(66)
    bytes[1] = 0x80
    bytes[65] = 1
    DRBG.prototype.generate = () => bytes
    try {
      const ec = new EC('p521')
      const key = ec.keyFromPrivate('1')
      const expectedNonce = new BN(bytes).ushrn(7)
      const signature = ec.sign('01', key)
      expect(signature.r.eq(ec.g.mul(expectedNonce).getX().umod(ec.n))).toBe(true)
      expect(ec.verify('01', signature, key)).toBe(true)
    } finally {
      DRBG.prototype.generate = generate
    }
  })
  it('keeps zero-bit masks valid in both legacy unit-conversion dependencies', () => {
    const engine = childLoader(root, '@railgun-community/engine')
    const circom = childLoader(engine, '@railgun-community/circomlibjs')
    const utils = childLoader(circom, 'web3-utils')
    const units = childLoader(utils, 'ethjs-unit')
    for (const loader of [units, childLoader(units, 'number-to-bn')]) {
      const BN = loader('bn.js')
      const zero = new BN(123).maskn(0)
      expect(zero.isZero()).toBe(true)
      expect(zero.toString(10)).toBe('0')
    }
  })
  it('bounds SDK history duplicate checks without dropping new events or overwriting existing events', async () => {
    const { UTXOMerkletree } = root(
      join(dirname(root.resolve('@railgun-community/engine')), 'merkletree/utxo-merkletree.js'),
    )
    let active = 0
    let peak = 0
    let checked = 0
    const events = Array.from({ length: 1025 }, (_, i) => ({ txid: String(i), eventLogIndex: i }))
    const fake = {
      hasExistingUnshieldEvent: async (event) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active--
        checked++
        return event.eventLogIndex % 2 === 0
      },
      getUnshieldEventsDBPath: (txid) => [txid],
      db: { batch: async (ops) => ops },
    }
    const writes = await UTXOMerkletree.prototype.addUnshieldEvents.call(fake, events)
    expect(peak).toBeLessThanOrEqual(256)
    expect(checked).toBe(events.length)
    expect(writes.map((write) => write.value)).toEqual(events.filter((event) => event.eventLogIndex % 2 !== 0))
    checked = 0
    const replaced = await UTXOMerkletree.prototype.addUnshieldEvents.call(fake, events, true)
    expect(checked).toBe(0)
    expect(replaced.map((write) => write.value)).toEqual(events)
  })
  for (const [name, loader] of [
    ['GraphQL utils 9', cross],
    ['GraphQL utils 8', validation],
  ]) {
    it(`${name}: prevents prototype keys in merged network data`, async () => {
      const common = loader('@graphql-tools/utils').mergeDeep
      const esm = (
        await import(new URL('../esm/mergeDeep.js', pathToFileURL(loader.resolve('@graphql-tools/utils'))).href)
      ).mergeDeep
      for (const mergeDeep of [common, esm]) {
        const payload = JSON.parse(
          '{"nested":{"__proto__":{"ophisPatchTest":true},"constructor":{"prototype":{"ophisPatchTest":true}},"prototype":{"ophisPatchTest":true}}}',
        )
        const result = mergeDeep([{ nested: { original: true } }, payload])
        expect(result.nested.original).toBe(true)
        expect(result.nested.ophisPatchTest).toBeUndefined()
        expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype)
        expect(Object.hasOwn(result.nested, 'constructor')).toBe(false)
        expect(Object.hasOwn(result.nested, 'prototype')).toBe(false)
      }
    })
  }
  it('rejects a peer record signed by a different peer before touching the datastore', async () => {
    const broadcaster = createRequire(root.resolve('@railgun-community/waku-broadcaster-client-web'))
    const waku = childLoader(broadcaster, '@waku/sdk')
    const libp2p = childLoader(waku, 'libp2p')
    const peerStore = childLoader(libp2p, '@libp2p/peer-store')
    const recordLoader = childLoader(peerStore, '@libp2p/peer-record')
    const { persistentPeerStore } = await importDependency(libp2p, '@libp2p/peer-store')
    const { RecordEnvelope, PeerRecord } = await importDependency(peerStore, '@libp2p/peer-record')
    const { generateKeyPair } = await importDependency(recordLoader, '@libp2p/crypto', './keys')
    const { peerIdFromPrivateKey } = await importDependency(peerStore, '@libp2p/peer-id')
    const aliceKey = await generateKeyPair('Ed25519')
    const bobKey = await generateKeyPair('Ed25519')
    const alice = peerIdFromPrivateKey(aliceKey)
    const bob = peerIdFromPrivateKey(bobKey)
    const log = Object.assign(() => {}, { error: () => {}, trace: () => {} })
    const store = persistentPeerStore({
      peerId: alice,
      datastore: {
        get: async () => {
          throw new Error('datastore reached')
        },
      },
      logger: { forComponent: () => log },
      events: new EventTarget(),
    })
    const forged = await RecordEnvelope.seal(new PeerRecord({ peerId: bob, multiaddrs: [] }), aliceKey)
    await expect(store.consumePeerRecord(forged.marshal())).resolves.toBe(false)
    const valid = await RecordEnvelope.seal(new PeerRecord({ peerId: alice, multiaddrs: [] }), aliceKey)
    await expect(store.consumePeerRecord(valid.marshal())).rejects.toThrow('datastore reached')
  })
})
