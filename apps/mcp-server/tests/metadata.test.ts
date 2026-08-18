import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { MCP_SERVER_VERSION, OPHIS_TOOL_NAMES, registerOphisTools, SERVER_INFO } from '../src/tools.js'

interface PackageMetadata {
  version: string
}

interface RegistryMetadata {
  version: string
  _meta: {
    'io.modelcontextprotocol.registry/publisher-provided': {
      version: string
      tools: string[]
    }
  }
}

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata
const registryMetadata = JSON.parse(
  readFileSync(new URL('../server.json', import.meta.url), 'utf8'),
) as RegistryMetadata

describe('MCP release metadata', () => {
  it('keeps the runtime, package, and registry versions identical', () => {
    expect(SERVER_INFO.version).toBe(MCP_SERVER_VERSION)
    expect(packageMetadata.version).toBe(MCP_SERVER_VERSION)
    expect(registryMetadata.version).toBe(MCP_SERVER_VERSION)
    expect(registryMetadata._meta['io.modelcontextprotocol.registry/publisher-provided'].version).toBe(
      MCP_SERVER_VERSION,
    )
  })

  it('keeps the registered and published 14-tool inventories identical', () => {
    const registerTool = vi.fn()
    registerOphisTools({ registerTool } as never)
    const registered = registerTool.mock.calls.map(([name]) => name as string)
    const published = registryMetadata._meta['io.modelcontextprotocol.registry/publisher-provided'].tools

    expect([...registered].sort()).toEqual([...OPHIS_TOOL_NAMES].sort())
    expect(new Set(registered)).toHaveLength(14)
    expect(published).toEqual(OPHIS_TOOL_NAMES)
    expect(registered).toHaveLength(14)
  })
})
