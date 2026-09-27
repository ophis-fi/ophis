import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { EVM_CHAINS } from '../src/data/chains.ts'

const script = readFileSync(new URL('../public/webmcp.js', import.meta.url), 'utf8')
const expected = Object.fromEntries(EVM_CHAINS.map(({ slug, chainId }) => [slug, chainId]))
const document = { currentScript: { dataset: { chainIds: JSON.stringify(expected) } } }
for (const method of ['provideContext', 'registerTool']) {
  const registered = []
  const modelContext = method === 'provideContext'
    ? { provideContext: ({ tools }) => registered.push(...tools) }
    : { registerTool: (tool) => registered.push(tool) }
  runInNewContext(script, { navigator: { modelContext }, document })
  const open = registered.find((tool) => tool.name === 'open_ophis_swap').execute
  for (const [slug, id] of Object.entries(expected)) {
    assert.equal((await open({ chain: ` ${slug.toUpperCase()} ` })).content[0].text, `https://swap.ophis.fi/#/${id}/swap`)
  }
  assert.equal((await open({})).content[0].text, 'https://swap.ophis.fi/')
  for (const chain of ['unknown', 'optimism/evil', '__proto__', 'constructor', 10, {}]) {
    await assert.rejects(() => open({ chain }), /chain slug/)
  }
}
runInNewContext(script, {}) // Browsers without WebMCP remain a no-op.
console.log('WebMCP: numeric chain links, invalid inputs and registration fallbacks passed')
