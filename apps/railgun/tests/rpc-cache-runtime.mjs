// Actual workerd/SQLite regression; every outbound request is intercepted with synthetic data.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = wranglerRequire('miniflare')
const { build } = wranglerRequire('esbuild')
const endpoint = 'https://arb-mainnet.g.alchemy.com/v2/SYNTHETIC_NO_KEY'
const entryPoint = fileURLToPath(new URL('../server/index.ts', import.meta.url))
const call = (id, method = 'eth_blockNumber') => ({ jsonrpc: '2.0', id, method, params: [] })
const wrapper = `import worker from './bundle.mjs';
export { ValidationCloudBudget } from './bundle.mjs';
export default { fetch(request, env) { const limit = { limit: async () => ({ success: true }) };
return worker.fetch(request, { ...env, RPC_LIMIT: limit, TRACE_LIMIT: limit }); } };`

async function runtime(legacy, redirect) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, format: 'esm',
    platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent',
    plugins: legacy ? [{ name: 'reproduce-previous-redirect-mode', setup(builder) {
      builder.onLoad({ filter: /server\/budget\.ts$/ }, ({ path }) => {
        const contents = readFileSync(path, 'utf8'), previous = "redirect: 'manual'"
        assert.equal(contents.split(previous).length, 2)
        return { contents: contents.replace(previous, "redirect: 'error'"), loader: 'ts' }
      })
    } }] : [] })
  const urls = []
  const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-10-19', log: new Log(LogLevel.NONE),
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: wrapper },
      { type: 'ESModule', path: 'bundle.mjs', contents: result.outputFiles[0].text }],
    durableObjects: { VALIDATION_CLOUD_BUDGET: { className: 'ValidationCloudBudget', useSQLite: true } },
    bindings: { RAILGUN_RPC_ENABLED: 'true', RAILGUN_ARBITRUM_RPC_URL: endpoint },
    outboundService: async request => {
      urls.push(request.url)
      if (request.url !== endpoint) return new Response('Unexpected redirected target', { status: 500 })
      if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://redirect.invalid/' } })
      await delay(25)
      const payload = await request.json()
      const reply = item => ({ jsonrpc: '2.0', id: item.id, result: item.method === 'eth_blockNumber' ? '0x123' : '0xa4b1' })
      return Response.json(Array.isArray(payload) ? payload.map(reply) : reply(payload))
    } }))
  const send = payload => mf.dispatchFetch('https://swap.ophis.fi/rpc/42161', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  try {
    const replies = await Promise.all(Array.from({ length: legacy || redirect ? 1 : 8 }, (_, id) => send(call(id))))
    for (const [id, response] of replies.entries()) {
      assert.equal(response.status, legacy || redirect ? 502 : 200)
      if (!legacy && !redirect) assert.deepEqual(await response.json(), { jsonrpc: '2.0', id, result: '0x123' })
    }
    assert.equal(urls.length, legacy ? 0 : 1, 'parallel cached heads must share one upstream read')
    assert.equal((await send(call(99))).status, legacy || redirect ? 502 : 200)
    assert.equal(urls.length, legacy ? 0 : 1, 'cache/failure backoff must prevent repeated upstream reads')
    const mixed = await send([call(1), call(2, 'eth_chainId')])
    assert.equal(mixed.status, redirect ? 502 : 200)
    if (!redirect) assert.deepEqual(await mixed.json(), [
      { jsonrpc: '2.0', id: 1, result: '0x123' }, { jsonrpc: '2.0', id: 2, result: '0xa4b1' }])
    assert.deepEqual(urls, Array(legacy ? 1 : 2).fill(endpoint), '3xx must never follow Location')
  } finally { await mf.dispose() }
}

await runtime(true, false)
await runtime(false, false)
await runtime(false, true)
console.log('PASS: old redirect mode fails; fixed single/batch RPCs, head coalescing and redirect refusal work in workerd.')
