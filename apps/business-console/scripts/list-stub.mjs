// A local stand-in for the place where the OFAC list file lives (M10), on http://127.0.0.1:8794/ofac.json. Locally
// SANCTIONS_URL points here (.dev.vars, made by "pnpm seed"): the Worker holds no stub and no switch. It serves what
// the maker (scripts/ofac-list.mjs) builds from the test XML, tests/fixtures/sdn-test.xml, read at every question:
// invented values, and one wallet that the indexer stand-in's fixture names as referred, so a partner's Overview shows a flag.
//   node scripts/list-stub.mjs     serve until stopped ("pnpm dev", "pnpm test:e2e" and "pnpm tour" start it themselves)
// To see the other cases, open http://127.0.0.1:8794/stub/<mode>: ok, shrunk (one address), grown (five), older
// (published a day earlier), shape (the count as a text), down (500). Each but ok and down is another file (another
// SHA-256). The mode stays until the next one.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from './ofac-list.mjs'

export const PORT = 8794
const XML = new URL('../tests/fixtures/sdn-test.xml', import.meta.url)
const MODES = ['ok', 'shrunk', 'grown', 'older', 'shape', 'down']
const other = (file, change) => ({ ...file, sha256: file.sha256.replace(/^./, (first) => (first === '0' ? '1' : '0')), ...change })
const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

/** Starts the stand-in on 127.0.0.1 and returns the function that stops it. */
export function start() {
  let mode = 'ok'
  const server = createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const picked = request.method === 'GET' && /^\/stub\/([a-z]+)$/.exec(request.url)?.[1]
    if (picked && MODES.includes(picked)) return send(200, { mode: (mode = picked) })
    if (request.method !== 'GET' || request.url !== '/ofac.json') return send(404, { error: 'not found' })
    if (mode === 'down') return send(500, { error: 'internal' })
    const file = build(readFileSync(XML), 'sdn-test.xml')
    const more = [1, 2, 3].map((n) => `0x${String(n).padStart(40, 'c')}`) // invented
    send(200, mode === 'shrunk' ? other(file, { count: 1, addresses: file.addresses.slice(0, 1) })
      : mode === 'grown' ? other(file, { count: file.count + more.length, addresses: [...file.addresses, ...more] })
      : mode === 'older' ? other(file, { published: dayBefore(file.published) })
      : mode === 'shape' ? other(file, { count: String(file.count) }) : file)
  }).listen(PORT, '127.0.0.1')
  return () => (server.closeAllConnections(), server.close())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start()
  console.log(`List stand-in on http://127.0.0.1:${PORT}/ofac.json. Modes: http://127.0.0.1:${PORT}/stub/${MODES.join('|')}`)
}
