// Two local stand-ins for the DNS-over-HTTPS resolvers of the local environment (RESOLVERS in src/server/onboarding.ts):
// http://127.0.0.1:8790/dns-query answers in Cloudflare's JSON form, http://127.0.0.1:8791/resolve in Google's.
// The Worker holds no stub and no switch: locally its two resolver constants point here.
// Records live in .wrangler/dns-stub.json, { "<name>": ["<value>", ...] }, read at every question.
//   node scripts/dns-stub.mjs                      serve until stopped
//   node scripts/dns-stub.mjs <command> [args]     serve while that command runs ("pnpm dev": wrangler dev), together with the
//                                                  stand-ins for the company sign-in (scripts/idp-stub.mjs, port 8792) and
//                                                  for the rebate indexer (scripts/indexer-stub.mjs, port 8793)
//   node scripts/dns-stub.mjs set <name> <value>   publish a TXT record, as a DNS administrator would ("pnpm dns")
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { start as startIdp } from './idp-stub.mjs'
import { start as startIndexer } from './indexer-stub.mjs'
import { start as startLists } from './list-stub.mjs'

const FOLDER = fileURLToPath(new URL('../.wrangler/', import.meta.url))
const FILE = `${FOLDER}dns-stub.json`
const stored = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {})

/** Publishes one TXT value under a name: both stubs answer it from then on. */
export function publish(name, value) {
  mkdirSync(FOLDER, { recursive: true })
  const records = stored()
  writeFileSync(FILE, `${JSON.stringify({ ...records, [name]: [...new Set([...(records[name] ?? []), value])] }, null, 2)}\n`)
}
/** Starts both stubs on 127.0.0.1 and returns the function that stops them. A name with no record is NXDOMAIN (status 3). */
export function start() {
  const servers = [8790, 8791].map((port, google) => createServer((request, response) => {
    const name = new URL(request.url, 'http://stub').searchParams.get('name') ?? ''
    const shown = google ? `${name}.` : name
    const Answer = (stored()[name] ?? []).map((value) => ({ name: shown, type: 16, TTL: 60, data: google ? value : `"${value}"` }))
    response.writeHead(200, { 'content-type': 'application/dns-json' })
    response.end(JSON.stringify({ Status: Answer.length ? 0 : 3, Question: [{ name: shown, type: 16 }], ...(Answer.length && { Answer }) }))
  }).listen(port, '127.0.0.1'))
  return () => servers.forEach((server) => server.close())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'set' && args.length === 2) {
    publish(args[0], args[1])
    console.log(`Published TXT ${args[0]}`)
  } else if (command === 'set') {
    console.error('usage: node scripts/dns-stub.mjs set <name> <value>')
    process.exitCode = 1
  } else {
    const stop = start()
    if (command) {
      const stopIdp = startIdp()
      const stopIndexer = startIndexer()
      const stopLists = startLists() // M10: the OFAC list file, port 8794
      spawn(command, args, { stdio: 'inherit' }).on('exit', (code) => {
        stop()
        stopIdp()
        stopIndexer()
        stopLists()
        process.exitCode = code ?? 1
      })
    } else console.log('DNS stubs on http://127.0.0.1:8790/dns-query and http://127.0.0.1:8791/resolve. Records: .wrangler/dns-stub.json')
  }
}
