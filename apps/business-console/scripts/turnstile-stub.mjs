// The local stand-in for Cloudflare Turnstile, the bot check of /recover (src/server/index.ts, TURNSTILE): locally
// nothing reaches Cloudflare. Its api.js solves at once with Cloudflare's dummy token, as Cloudflare's test key does.
// Its siteverify takes that token only with Cloudflare's public test secret, and answers for this machine's host and
// the action "recover", so the server's host and action checks run here too.
//   TURNSTILE_URL=http://127.0.0.1:8796 and that test secret are in .dev.vars (made by "pnpm seed").
//   "pnpm dev", "pnpm test:e2e" and "pnpm tour" start it.
import { createServer } from 'node:http'

export const PORT = 8796
export const TEST_SECRET = '1x0000000000000000000000000000000AA' // Cloudflare's public test secret: it takes only the dummy token
export const DUMMY = 'XXXX.DUMMY.TOKEN.XXXX'
const API = `window.turnstile = (() => {
  const widgets = new Map()
  const solve = (options) => setTimeout(() => options.callback && options.callback(${JSON.stringify(DUMMY)}))
  return {
    ready: (run) => run(),
    render: (box, options) => {
      const id = 'w' + (widgets.size + 1)
      widgets.set(id, options)
      box.textContent = 'Check that you are a person: the local stand-in passes it.'
      solve(options)
      return id
    },
    reset: (id) => widgets.has(id) && solve(widgets.get(id)),
    remove: (id) => widgets.delete(id),
  }
})()`

/** Starts the stand-in on 127.0.0.1 and returns the function that stops it. */
export function start() {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/turnstile/v0/api.js')) return response.writeHead(200, { 'content-type': 'text/javascript' }).end(API)
    if (request.method !== 'POST' || request.url !== '/turnstile/v0/siteverify') return response.writeHead(404).end()
    let body = ''
    request.on('data', (chunk) => (body += chunk)).on('end', () => {
      let asked = {}
      try {
        asked = JSON.parse(body)
      } catch {
        // not JSON: refused below
      }
      const ok = asked.secret === TEST_SECRET && asked.response === DUMMY
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ok ? { success: true, hostname: 'localhost', action: 'recover', 'error-codes': [] } : { success: false, 'error-codes': ['invalid-input-response'] }))
    })
  }).listen(PORT, '127.0.0.1')
  return () => (server.closeAllConnections(), server.close())
}
