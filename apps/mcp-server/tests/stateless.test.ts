import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

let worker: Unstable_DevWorker | undefined
const directory = mkdtempSync(join(tmpdir(), 'ophis-mcp-test-'))

beforeAll(async () => {
  const config = join(directory, 'wrangler.json')
  // No DO or remote bindings: reverting to McpAgent must fail this check.
  writeFileSync(config, JSON.stringify({
    name: 'ophis-mcp-test',
    compatibility_date: '2025-05-01',
    compatibility_flags: ['nodejs_compat'],
  }))
  worker = await unstable_dev(resolve('src/index.ts'), {
    config, local: true, persist: false, port: 0, inspectorPort: 0, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  })
}, 30_000)

afterAll(async () => {
  await worker?.stop()
  rmSync(directory, { recursive: true, force: true })
})

it('initializes and serves independent tool requests without Durable Objects', async () => {
  const call = async (id: number, method: string, params: unknown) => {
    const response = await worker!.fetch('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBeNull()
    const body = await response.json() as { id: number; error?: unknown; result: any }
    expect(body.id).toBe(id)
    expect(body.error).toBeUndefined()
    return body.result
  }
  const init = await call(1, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  })
  expect(init.serverInfo.name).toBe('ophis')
  const [listed, called] = await Promise.all([
    call(2, 'tools/list', {}), call(3, 'tools/call', { name: 'list_chains', arguments: {} }),
  ])
  expect(listed.tools).toHaveLength(14)
  expect(JSON.parse(called.content[0].text).tradeable.some((chain: { chainId: number }) => chain.chainId === 1)).toBe(true)
  expect((await worker!.fetch('/mcp', { headers: { accept: 'text/event-stream' } })).status).toBe(405)
})
