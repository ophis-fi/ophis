import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'
import config from '../vite.config'

it('forwards a path-based RPC and its query exactly once', async () => {
  const upstream = createHttpServer((request, response) => response.end(request.url))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  vi.stubEnv('RAILGUN_RPC_URL', `http://127.0.0.1:${upstreamAddress.port}/provider/rpc?network=1`)
  const options = await config({ command: 'serve', mode: 'test' })
  const server = await createServer({
    ...options,
    configFile: false,
    server: { ...options.server, port: 0, strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert(address && typeof address === 'object')
    for (const path of ['/rpc', '/rpc/1']) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('/provider/rpc?network=1')
    }
  } finally {
    await server.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    vi.unstubAllEnvs()
  }
})
