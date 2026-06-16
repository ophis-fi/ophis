/**
 * Ophis MCP server — standalone stdio entrypoint (plain Node ESM).
 *
 * Same six tools as the Cloudflare Worker (src/index.ts), exposed over a stdio
 * MCP transport so the server can run in a container (e.g. for the Glama.ai
 * registry) or be spawned directly by an MCP client. stdout is the MCP channel:
 * write NOTHING to it except protocol frames. Diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { registerOphisTools, SERVER_INFO } from './tools.js'

try {
  const server = new McpServer(SERVER_INFO)
  registerOphisTools(server, {
    defaultReferrerCode: process.env.OPHIS_DEFAULT_REFERRER_CODE,
    rebatesApi: process.env.OPHIS_REBATES_API,
  })
  await server.connect(new StdioServerTransport())
} catch (e) {
  // stderr only — stdout is the MCP transport and must carry protocol frames only.
  process.stderr.write(`ophis-mcp (stdio) failed to start: ${(e as Error)?.stack ?? e}\n`)
  process.exit(1)
}
