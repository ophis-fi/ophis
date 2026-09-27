import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../public/webmcp.js', import.meta.url), 'utf8')
const chains = readFileSync(new URL('../src/data/chains.ts', import.meta.url), 'utf8')
const expected = {
  ethereum: 1, optimism: 10, bnb: 56, gnosis: 100, unichain: 130,
  polygon: 137, robinhood: 4663, arc: 5042, base: 8453, plasma: 9745,
  arbitrum: 42161, avalanche: 43114, ink: 57073, linea: 59144,
}
assert.deepEqual(
  Object.values(expected).sort((a, b) => a - b),
  [...chains.matchAll(/chainId: (\d+),/g)].map((m) => Number(m[1])).sort((a, b) => a - b),
  'WebMCP must cover the canonical app chains',
)
for (const method of ['provideContext', 'registerTool']) {
  const registered = []
  const modelContext = method === 'provideContext'
    ? { provideContext: ({ tools }) => registered.push(...tools) }
    : { registerTool: (tool) => registered.push(tool) }
  runInNewContext(script, { navigator: { modelContext } })
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
