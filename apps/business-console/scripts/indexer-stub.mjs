// A local stand-in for the Ophis rebate indexer's one route for this console, POST /business/partner, on
// http://127.0.0.1:8793. Locally INDEXER_URL points here and INDEXER_TOKEN is this stand-in's token (both in .dev.vars,
// made by "pnpm seed"): the Worker holds no stub and no switch. It shares no code with the Worker or the indexer.
// The figures are the contract file of the indexer's own test, read WHERE IT IS at every question (no copy):
// apps/rebate-indexer/tests/fixtures/business-partner.json. A wallet of that file gets its entry; any other wallet gets
// no partner code and zero fees. The bearer rule is the real route's: off (404) without a token of 32 characters, 401 else.
//   node scripts/indexer-stub.mjs     serve until stopped ("pnpm dev" and "pnpm test:e2e" start it themselves)
// To see the failing cases, open http://127.0.0.1:8793/stub/<mode>: ok, slow (answers after 6 s), shape (a number as
// text), 500. The mode stays until the next one.
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

export const PORT = 8793
export const CONTRACT = new URL('../../rebate-indexer/tests/fixtures/business-partner.json', import.meta.url)
const VARS = new URL('../.dev.vars', import.meta.url)
const MODES = ['ok', 'slow', 'shape', '500']
const tokenOf = () => (existsSync(VARS) ? readFileSync(VARS, 'utf8').match(/^INDEXER_TOKEN=(.+)$/m)?.[1] ?? '' : '')

/** Starts the stand-in on 127.0.0.1 and returns the function that stops it. */
export function start() {
  let mode = 'ok'
  const server = createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const picked = request.method === 'GET' && /^\/stub\/([a-z0-9]+)$/.exec(request.url)?.[1]
    if (picked && MODES.includes(picked)) return send(200, { mode: (mode = picked) })
    if (request.method !== 'POST' || request.url !== '/business/partner') return send(404, { error: 'not found' })
    const token = Buffer.from(tokenOf())
    if (token.length < 32) return send(404, { error: 'not found' })
    const presented = Buffer.from(/^Bearer (.*)$/.exec(request.headers.authorization ?? '')?.[1] ?? '')
    if (presented.length !== token.length || !timingSafeEqual(presented, token)) return send(401, { error: 'unauthorized' })
    let text = ''
    request.on('data', (chunk) => (text.length < 10_000 ? (text += chunk) : request.destroy()))
    request.on('end', () => {
      let wallets
      try {
        wallets = JSON.parse(text).wallets
      } catch {
        return send(400, { error: 'bad json' })
      }
      if (!Array.isArray(wallets) || wallets.length < 1 || wallets.length > 10 || !wallets.every((w) => typeof w === 'string' && /^0x[0-9a-f]{40}$/.test(w)) || new Set(wallets).size !== wallets.length) return send(400, { error: 'wallets' })
      if (mode === '500') return send(500, { error: 'internal' })
      const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
      const empty = contract.wallets.find((w) => w.affiliate === null)
      const answer = {
        asOf: new Date().toISOString(),
        wallets: wallets.map((wallet) => contract.wallets.find((w) => w.wallet === wallet) ?? { ...empty, wallet, fees: { ...empty.fees, recipient: wallet } }),
      }
      if (mode === 'shape') answer.wallets[0] = { ...answer.wallets[0], fees: { ...answer.wallets[0].fees, lifetime: { ...answer.wallets[0].fees.lifetime, tradeCount: '412' } } }
      setTimeout(() => send(200, answer), mode === 'slow' ? 6000 : 0)
    })
  }).listen(PORT, '127.0.0.1')
  return () => (server.closeAllConnections(), server.close())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start()
  console.log(`Indexer stand-in on http://127.0.0.1:${PORT}/business/partner. Modes: http://127.0.0.1:${PORT}/stub/${MODES.join('|')}`)
}
