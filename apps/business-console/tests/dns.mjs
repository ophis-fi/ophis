// On demand (pnpm test:dns), needs the network. Asks the two real resolvers the production entry will use
// (Cloudflare and Google, DNS-over-HTTPS, JSON form) for one stable public TXT record, through the server's own
// lookup (same URL, header, timeout, size cap and parser as "Check DNS"), and prints what each one answered.
// It sends one public name and nothing else.
import { DNS, lookup, PUBLIC_RESOLVERS } from '../src/server/onboarding.ts'

const NAME = 'example.com' // reserved by IANA; its SPF record has not changed in years
const EXPECTED = 'v=spf1 -all'
let failed = false
for (const resolver of PUBLIC_RESOLVERS) {
  const raw = await fetch(`${resolver}?name=${NAME}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS.timeoutMs) }).then((r) => r.text(), (error) => `no answer: ${error.name}`)
  const values = await lookup(resolver, NAME)
  const ok = Boolean(values?.includes(EXPECTED))
  failed ||= !ok
  console.log(`${ok ? 'ok  ' : 'FAILED'} ${resolver}\n     raw (${raw.length} bytes): ${raw.slice(0, 600)}\n     parsed: ${JSON.stringify(values)}`)
}
console.log(failed ? `FAILED: a resolver did not give ${JSON.stringify(EXPECTED)} for ${NAME}` : `Both resolvers gave ${JSON.stringify(EXPECTED)} for ${NAME}, read by the server's parser.`)
process.exitCode = failed ? 1 : 0
