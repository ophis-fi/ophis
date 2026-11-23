import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const wallet = createRequire(require.resolve('@railgun-community/wallet'))
const mesh = createRequire(wallet.resolve('@graphql-mesh/graphql'))
const urlLoader = createRequire(mesh.resolve('@graphql-tools/url-loader'))

it('loads the Node SDK and signs without the unused React Native crypto dependency', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (name, ...args) {
      assert(!['crypto-browserify', 'react-native-shims', 'elliptic'].some(dependency => name.includes(dependency)),
        'The broadcaster must not load React Native cryptography: ' + name);
      return originalLoad.call(this, name, ...args);
    };
    const sdk = require('@railgun-community/wallet');
    assert.equal(typeof sdk.startRailgunEngine, 'function');
    const { Wallet, verifyMessage } = require('ethers');
    const signer = new Wallet('0x' + '00'.repeat(31) + '01');
    const message = 'broadcaster dependency regression';
    signer.signMessage(message).then(signature => {
      assert.equal(verifyMessage(message, signature), signer.address);
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `
  execFileSync(process.execPath, ['-e', script], { cwd: dirname(require.resolve('../package.json')), timeout: 20_000 })
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  expect(lock).not.toMatch(/^  (?:elliptic|crypto-browserify|browserify-sign|create-ecdh)@/m)
})

it.each(['commonjs', 'module'])('uses a TLS-verified executor with separate authentication and routing (%s)', async (format) => {
  const entry = mesh.resolve('@graphql-tools/url-loader')
  const { UrlLoader } = format === 'commonjs'
    ? mesh('@graphql-tools/url-loader')
    : await import(pathToFileURL(join(dirname(entry), '../esm/index.js')).href)
  const sockets: Socket[] = []
  class Socket {
    readyState = 1
    sent: { type: string; id?: string; payload?: unknown }[] = []
    onopen?: () => void
    onmessage?: (event: { data: string }) => void
    constructor(_url: string, _protocol: unknown, readonly options: { rejectUnauthorized?: boolean }) { sockets.push(this) }
    send(message: string) { this.sent.push(JSON.parse(message)) }
    terminate() {}
    receive(message: unknown) {
      if (!this.onmessage) throw new Error('Missing WebSocket message handler.')
      this.onmessage({ data: JSON.stringify(message) })
    }
  }
  const executor = new UrlLoader().buildWSLegacyExecutor('wss://example.invalid/graphql', Socket, {})
  const document = urlLoader('graphql').parse('subscription { tick }')
  const alice = executor({ document, extensions: { connectionParams: { token: 'alice' } } })
  executor({ document })
  expect(sockets).toHaveLength(2)
  for (const socket of sockets) socket.onopen?.()
  expect(sockets.map(socket => socket.options.rejectUnauthorized)).toEqual([true, true])
  expect(sockets.map(socket => socket.sent[0].payload)).toEqual([{ token: 'alice' }, {}])
  sockets[0].receive({ type: 'connection_ack' })
  const { id } = sockets[0].sent[1]
  expect(id).toBeTypeOf('string')
  sockets[0].receive({ type: 'data', id: `${id}-other`, payload: { data: { tick: 'other' } } })
  sockets[0].receive({ type: 'data', id, payload: { data: { tick: 'alice' } } })
  expect((await alice.next()).value).toEqual({ data: { tick: 'alice' } })
})

it.each(['@graphql-mesh/cross-helpers', '@envelop/extended-validation'])('%s uses fixed GraphQL merge utilities', async (consumer) => {
  const loader = consumer === '@graphql-mesh/cross-helpers'
    ? createRequire(wallet.resolve(consumer))
    : createRequire(createRequire(wallet.resolve('@graphql-mesh/runtime')).resolve(consumer))
  const utils = '@graphql-tools/utils'
  const entry = dirname(loader.resolve(utils))
  const version = JSON.parse(readFileSync(join(entry, '../package.json'), 'utf8')).version
  expect(version).toBe('12.1.0')
  const esm = await import(pathToFileURL(join(entry, '../esm/index.js')).href)
  for (const { mergeDeep, AggregateError: MeshAggregateError } of [loader(utils), esm]) {
    expect(MeshAggregateError).toBe(AggregateError)
    const payload = JSON.parse('{"nested":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}}')
    const merged = mergeDeep([{ nested: { kept: true } }, payload])
    expect(merged.nested.kept).toBe(true)
    expect(merged.nested.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(merged.nested)).toBe(Object.prototype)
    expect(Object.hasOwn(merged.nested, 'constructor')).toBe(false)
    expect(Object.hasOwn(merged.nested, 'prototype')).toBe(false)
  }
})

it.each(['commonjs', 'module'])('serves Mesh HTTP routes without the Zod dependency chain (%s)', async (format) => {
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  expect(lock).not.toMatch(/^  (?:zod|zod-to-json-schema)@/m)

  const http = '@graphql-mesh/http'
  const { createMeshHTTPHandler } = format === 'commonjs'
    ? wallet(http)
    : await import(pathToFileURL(join(dirname(wallet.resolve(http)), '../esm/index.js')).href)
  const schema = wallet('graphql').buildSchema('type Query { status: String! }')
  schema.getQueryType().getFields().status.resolve = () => 'ready'
  const logger = { child() { return this }, debug() {}, info() {}, warn() {}, error() {} }
  let initializations = 0
  const router = createMeshHTTPHandler({
    baseDir: process.cwd(),
    getBuiltMesh: async () => {
      initializations++
      return {
        plugins: [{ onPluginInit({ setSchema }: { setSchema: (value: typeof schema) => void }) { setSchema(schema) } }],
        logger,
        pubsub: { getEventNames: () => [] },
      }
    },
  })

  expect((await router.fetch('http://example.invalid/healthcheck')).status).toBe(200)
  expect((await router.fetch('http://example.invalid/readiness')).status).toBe(204)
  const redirect = await router.fetch('http://example.invalid/')
  expect(redirect.status).toBe(302)
  expect(redirect.headers.get('location')).toBe('/graphql')
  const query = await router.fetch('http://example.invalid/graphql?query=%7Bstatus%7D')
  expect(query.status).toBe(200)
  expect(await query.json()).toEqual({ data: { status: 'ready' } })
  expect(initializations).toBe(1)
})
