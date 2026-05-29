import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const dist = (f: string) => join(__dirname, '..', 'dist', f)
const json = (f: string) => JSON.parse(readFileSync(dist(f), 'utf8'))

test('openapi.json is a valid OpenAPI 3.1 spec for POST /api/intent', () => {
  expect(existsSync(dist('openapi.json'))).toBe(true)
  const spec = json('openapi.json')
  expect(spec.openapi).toMatch(/^3\.1/)
  expect(spec.servers[0].url).toBe('https://swap.ophis.fi')
  const op = spec.paths['/api/intent'].post
  expect(op.operationId).toBe('parseIntent')
  expect(op.responses['200']).toBeTruthy()
  expect(op.responses['429']).toBeTruthy() // documented rate limit
  // request/response schemas resolve
  for (const s of ['IntentRequest', 'Entity', 'ParsedIntent', 'IntentSuccess', 'IntentError']) {
    expect(spec.components.schemas[s]).toBeTruthy()
  }
  expect(spec.components.schemas.IntentRequest.properties.text.maxLength).toBe(280)
  expect(spec.components.schemas.Entity.properties.type.enum).toEqual(
    expect.arrayContaining(['sellToken', 'buyToken', 'amount', 'chain']),
  )
})

test('.well-known/mcp.json points to the live MCP server with all six tools', () => {
  const mcp = json('.well-known/mcp.json')
  expect(mcp.endpoint).toBe('https://mcp.ophis.fi/mcp')
  expect(mcp.transport).toBe('streamable-http')
  expect(mcp.authentication).toBe('none')
  const tools = mcp.tools.map((t: { name: string }) => t.name)
  expect(tools).toEqual(
    expect.arrayContaining(['parse_intent', 'get_quote', 'build_order', 'submit_order', 'lookup_tier', 'list_chains']),
  )
  expect(mcp.openapi).toBe('https://ophis.fi/openapi.json')
})

test('.well-known/ai-plugin.json cross-references the OpenAPI + MCP and needs no auth', () => {
  const plugin = json('.well-known/ai-plugin.json')
  expect(plugin.schema_version).toBe('v1')
  expect(plugin.auth.type).toBe('none')
  expect(plugin.api.type).toBe('openapi')
  expect(plugin.api.url).toBe('https://ophis.fi/openapi.json')
  expect(plugin.mcp.url).toBe('https://mcp.ophis.fi/mcp')
})

test('llms.txt references the OpenAPI + discovery manifests', () => {
  const llms = readFileSync(dist('llms.txt'), 'utf8')
  expect(llms).toContain('https://ophis.fi/openapi.json')
  expect(llms).toContain('/.well-known/mcp.json')
})
