import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, preview } from 'vite'
import { expect, it, vi } from 'vitest'
import config from '../vite.config'

it.each(['dev', 'preview'])('%s forwards only same-origin JSON RPC requests to the fixed upstream', async (mode) => {
  const paths: string[] = []
  const upstream = createHttpServer((request, response) => {
    paths.push(request.url || '')
    response.setHeader('Content-Type', 'text/plain')
    response.end('ok')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  vi.stubEnv('RAILGUN_RPC_URL', `http://127.0.0.1:${upstreamAddress.port}/provider/rpc?network=1`)
  const options = await config({ command: 'serve', mode: 'test' })
  const directory = mkdtempSync(join(tmpdir(), 'ophis-rpc-preview-'))
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>RPC fixture</title>')
  const settings = {
    ...options,
    cacheDir: join(directory, 'vite-cache'),
    configFile: false as const,
    server: { ...options.server, port: 0, strictPort: false },
    preview: { ...options.preview, port: 0, strictPort: false },
    build: { ...options.build, outDir: directory },
    optimizeDeps: { noDiscovery: true, include: [] },
  }
  const server = mode === 'dev' ? await createServer(settings) : await preview(settings)
  try {
    if ('listen' in server) await server.listen()
    const address = server.httpServer?.address()
    assert(address && typeof address === 'object')
    const origin = `http://127.0.0.1:${address.port}`
    for (const [headers, method, status] of [
      [{}, 'POST', 415],
      [{ 'Content-Type': 'text/plain' }, 'POST', 415],
      [{ 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', 415],
      [{ 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, 'POST', 403],
      [{ 'Content-Type': 'application/json', Origin: 'null' }, 'POST', 403],
      [{ 'Content-Type': 'application/json' }, 'GET', 405],
    ] as const) {
      expect((await fetch(`${origin}/rpc`, { method, headers })).status).toBe(status)
    }
    expect((await fetch(`${origin}/rpc/999`, { method: 'POST' })).status).toBe(503)
    expect(paths).toEqual([])
    for (const path of ['/rpc', '/rpc/1']) {
      const response = await fetch(`${origin}${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: origin } })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('ok')
    }
    expect(paths).toEqual(['/provider/rpc?network=1', '/provider/rpc?network=1'])
  } finally {
    await server.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
