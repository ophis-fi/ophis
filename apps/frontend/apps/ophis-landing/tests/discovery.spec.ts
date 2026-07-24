import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

test('.well-known/mcp.json points to the live MCP server with all twelve tools', () => {
  const mcp = json('.well-known/mcp.json')
  expect(mcp.endpoint).toBe('https://mcp.ophis.fi/mcp')
  expect(mcp.transport).toBe('streamable-http')
  expect(mcp.authentication).toBe('none')
  const tools = mcp.tools.map((t: { name: string }) => t.name)
  expect(tools).toEqual(
    expect.arrayContaining([
      'parse_intent',
      'resolve_token',
      'get_quote',
      'build_order',
      'submit_order',
      'lookup_tier',
      'list_chains',
      'get_balances',
      'get_portfolio',
      'get_gas',
      'get_token_chart',
      'expected_surplus',
    ]),
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
  expect(llms).toContain('/.well-known/agent-skills/index.json')
})

test('agent-skills index advertises the whole family and every digest matches the shipped bytes', () => {
  const manifest = json('.well-known/agent-skills/index.json')
  const names = manifest.skills.map((s: { name: string }) => s.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'swap-via-ophis',
      'ophis',
      'ophis-quote',
      'ophis-swap',
      'ophis-order-status',
      'ophis-cancel',
      'ophis-surplus-report',
    ]),
  )
  for (const skill of manifest.skills) {
    const pathname = decodeURIComponent(new URL(skill.url).pathname)
    const bytes = readFileSync(dist('.' + pathname))
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    expect(skill.digest, `digest for ${skill.name}`).toBe(digest)
  }
})

test('the umbrella skill policy pins the sovereign settlement + relayer, never the canonical CoW addresses', () => {
  const umbrella = readFileSync(dist('.well-known/agent-skills/ophis/SKILL.md'), 'utf8')
  // Optimism (10) + Unichain (130) Ophis deployments, from contracts/networks.json.
  expect(umbrella).toContain('0x310784c7FCE12d578dA6f53460777bAc9718B859') // settlement 10
  expect(umbrella).toContain('0x83847EaB41ad9ea43809ce71569eB2e9daF51830') // relayer 10
  expect(umbrella).toContain('0x108A678716e5E1776036eF044CAB7064226F714E') // settlement 130
  expect(umbrella).toContain('0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb') // relayer 130
  // The canonical CoW addresses are the wrong contracts on these chains.
  expect(umbrella).not.toContain('0x9008D19f58AAbD9eD0D60971565AA8510560ab41')
  expect(umbrella).not.toContain('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110')
})
