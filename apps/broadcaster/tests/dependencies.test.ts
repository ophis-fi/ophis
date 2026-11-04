import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const wallet = createRequire(require.resolve('@railgun-community/wallet'))
const mesh = createRequire(wallet.resolve('@graphql-mesh/graphql'))
const urlLoader = createRequire(mesh.resolve('@graphql-tools/url-loader'))

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

it.each(['@graphql-mesh/cross-helpers', '@envelop/extended-validation'])('%s uses patched GraphQL merge utilities', async (consumer) => {
  const loader = consumer === '@graphql-mesh/cross-helpers'
    ? createRequire(wallet.resolve(consumer))
    : createRequire(createRequire(wallet.resolve('@graphql-mesh/runtime')).resolve(consumer))
  const common = loader('@graphql-tools/utils').mergeDeep
  const version = JSON.parse(readFileSync(join(dirname(loader.resolve('@graphql-tools/utils')), '../package.json'), 'utf8')).version
  expect(version).toBe(consumer === '@graphql-mesh/cross-helpers' ? '9.2.1' : '8.13.1')
  const esm = (await import(pathToFileURL(join(dirname(loader.resolve('@graphql-tools/utils')), '../esm/mergeDeep.js')).href)).mergeDeep
  for (const mergeDeep of [common, esm]) {
    const payload = JSON.parse('{"nested":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}}')
    const merged = mergeDeep([{ nested: { kept: true } }, payload])
    expect(merged.nested.kept).toBe(true)
    expect(merged.nested.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(merged.nested)).toBe(Object.prototype)
    expect(Object.hasOwn(merged.nested, 'constructor')).toBe(false)
    expect(Object.hasOwn(merged.nested, 'prototype')).toBe(false)
  }
})

it('loads the real Node SDK zod backport in both CJS and ESM', async () => {
  const http = createRequire(wallet.resolve('@graphql-mesh/http'))
  const fets = createRequire(http.resolve('fets'))
  const schema = createRequire(fets.resolve('zod-to-json-schema'))
  const testZod = require('../../../scripts/test-zod3-security.cjs')
  expect(await testZod(schema)).toBe('3.25.76')
  const esm = await import(pathToFileURL(join(dirname(schema.resolve('zod')), 'index.js')).href)
  expect(await testZod((name: string) => name === 'zod' ? esm : schema(name))).toBe('3.25.76')
})
