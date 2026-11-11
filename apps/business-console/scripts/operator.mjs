// The operator's command, local only. It calls the operator's API of the local server (src/server/onboarding.ts) on
// that API's own hostname, with OPERATOR_TOKEN from .dev.vars (made by "pnpm seed"). The token is never printed.
//   node scripts/operator.mjs invite    a new application code: one use, valid 14 days; give it to the company that may apply
//   node scripts/operator.mjs list
//   node scripts/operator.mjs decide <organisation id> approve --submission <the 16 characters "list" printed> --tier standard --source registry --evidence "<reference>" --sha256 <64 hex> --next-review 2027-11-11
//   node scripts/operator.mjs decide <organisation id> more|refuse --reason <code> --tier standard --source registry
//   node scripts/operator.mjs freeze|unfreeze <organisation id>
// Reasons: entity_not_found, details_differ, authority_unclear, wallet_differs, declaration_needed, not_eligible.
// Sources: registry, gleif, supervisor_register, declaration. Tiers: standard, enhanced.
// The command sets nothing else: the API takes no passkey, no member and no wallet address.
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { parseArgs } from 'node:util'

const HOST = 'operator.localhost:8787' // the Worker decides by this name; the connection goes to 127.0.0.1
const { positionals: [command, id, decision], values } = parseArgs({
  allowPositionals: true,
  options: { tier: { type: 'string' }, source: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' }, sha256: { type: 'string' }, 'next-review': { type: 'string' }, submission: { type: 'string' } },
})
let token
try {
  token = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/^OPERATOR_TOKEN=(.+)$/m)?.[1]
} catch {
  // no file: the message below
}
if (!token) {
  console.error('No OPERATOR_TOKEN in .dev.vars. Run "pnpm seed" once: it adds one. Then restart "pnpm dev".')
  process.exit(1)
}

function call(method, path, body) {
  const text = body === undefined ? undefined : JSON.stringify(body)
  const headers = { host: HOST, 'sec-fetch-site': 'same-origin', authorization: `Bearer ${token}`, ...(text !== undefined && { origin: `http://${HOST}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) }
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 8787), method, path, headers }, (response) => {
      let data = ''
      response.setEncoding('utf8').on('data', (chunk) => (data += chunk)).on('end', () => {
        let answer = null
        try {
          answer = JSON.parse(data)
        } catch {
          // not JSON: a host that is not the operator's answers "Not found"
        }
        resolve({ status: response.statusCode, body: answer })
      })
    }).on('error', reject).end(text)
  })
}
const base = '/api/operator/organisations'
const answer = command === 'list' ? await call('GET', base)
  : command === 'invite' ? await call('POST', '/api/operator/invites', {})
  : command === 'decide' && id && decision ? await call('POST', `${base}/${id}/decision`, { decision, tier: values.tier, source: values.source, reason: values.reason, evidenceRef: values.evidence, evidenceSha256: values.sha256, nextReview: values['next-review'], submission: values.submission })
  : (command === 'freeze' || command === 'unfreeze') && id ? await call('POST', `${base}/${id}/${command}`, {})
  : null
if (!answer) {
  console.error('usage: node scripts/operator.mjs invite | list | decide <id> approve|more|refuse [--submission --tier --source --reason --evidence --sha256 --next-review] | freeze <id> | unfreeze <id>')
  process.exit(1)
}
if (answer.status !== 200) {
  console.error(`Refused (${answer.status}): ${answer.body?.error === 'submission_changed' ? 'the organisation changed and was submitted again since that list. Run "list" and compare again.' : answer.body?.error ?? 'no answer from the operator API: is "pnpm dev" running?'}`)
  process.exit(1)
}
if (command === 'invite') console.log(`Application code, one use, valid until ${new Date(answer.body.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC:\n${answer.body.code}`)
else if (command !== 'list') console.log(`Done: ${id} is now ${answer.body.state}.`)
else if (!answer.body.organisations.length) console.log('Nothing is under review.')
else {
  for (const o of answer.body.organisations) {
    console.log([
      `${o.id}  ${o.legalName} (${o.kind}, ${o.country}, ${o.registration})`,
      `  domain          ${o.domain}`,
      `  submitted       ${new Date(o.submittedAt).toISOString()}   submission ${o.submission} (name it in "approve": a change and a new submit make another)`,
      `  first Owner     ${o.phrase.join(' ')}   passkey hash ${o.credentialHash}`,
      `  recovery wallet ${o.wallet ? `${o.wallet.address} on ${o.wallet.chain}, ${o.wallet.kind}${o.wallet.threshold ? ` ${o.wallet.threshold} of ${o.wallet.owners}` : ''}, ${o.wallet.colour.level}${o.wallet.colour.why ? ` (${o.wallet.colour.why})` : ''}` : 'none: a second Owner with two passkeys'}`,
      `  ready           ${o.missing ? `no: ${o.missing}` : 'yes'}`,
    ].join('\n'))
  }
}
