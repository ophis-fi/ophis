import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transportFetch } = vi.hoisted(() => ({ transportFetch: vi.fn() }))
vi.mock('agents/mcp', () => ({
  createMcpHandler: () => transportFetch,
  McpAgent: class {
    static serve() { return { fetch: transportFetch } }
  },
}))

import worker from '../src/index.js'

const env = {
  get OPHIS_MCP(): never { throw new Error('Public MCP requests must not access Durable Objects') },
} as Parameters<typeof worker.fetch>[1]
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext
const post = (body: BodyInit, headers?: HeadersInit): Request => new Request('https://mcp.ophis.fi/mcp', {
  method: 'POST', body, headers, duplex: 'half',
} as RequestInit)

describe('MCP request body bounds', () => {
  beforeEach(() => {
    transportFetch.mockReset()
    transportFetch.mockImplementation(async (request: Request) => new Response(await request.text()))
  })

  it('rejects declared and multibyte over-cap bodies before invoking the transport', async () => {
    for (const request of [
      post('{}', { 'content-length': String(256 * 1024 + 1) }),
      post(JSON.stringify({ text: '€'.repeat(90 * 1024) })),
    ]) {
      expect((await worker.fetch(request, env, ctx)).status).toBe(413)
    }
    expect(transportFetch).not.toHaveBeenCalled()
  })

  it('cancels an oversized chunked body without draining its remainder', async () => {
    let reads = 0
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        if (reads === 1) controller.enqueue(new Uint8Array(256 * 1024 + 1))
        else controller.error(new Error('oversized body must not be drained'))
      },
      cancel,
    }, { highWaterMark: 0 })
    expect((await worker.fetch(post(body), env, ctx)).status).toBe(413)
    expect(cancel).toHaveBeenCalledOnce()
    expect(reads).toBe(1)
    expect(body.locked).toBe(false)
    expect(transportFetch).not.toHaveBeenCalled()
  })

  it('preserves split UTF-8 characters and the existing batch cap', async () => {
    const json = JSON.stringify({ text: '€' })
    const bytes = new TextEncoder().encode(json)
    const split = bytes.indexOf(0xe2) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split))
        controller.enqueue(bytes.slice(split))
        controller.close()
      },
    })
    const response = await worker.fetch(post(body), env, ctx)
    expect(await response.text()).toBe(json)
    expect(transportFetch).toHaveBeenCalledOnce()
    expect((await worker.fetch(post(JSON.stringify(Array(9).fill({}))), env, ctx)).status).toBe(429)
    expect(transportFetch).toHaveBeenCalledOnce()
    const atLimit = '{}'.padEnd(256 * 1024, ' ')
    expect(await (await worker.fetch(post(atLimit), env, ctx)).text()).toBe(atLimit)
  })
})
