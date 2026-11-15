// The operator's command, local only. It calls the operator's API of the local server (src/server/onboarding.ts) on
// that API's own hostname, with OPERATOR_TOKEN from .dev.vars (made by "pnpm seed"). The token is never printed.
//   node scripts/operator.mjs invite    a new application code: one use, valid 14 days; give it to the company that may apply
//   node scripts/operator.mjs list      the 3 oldest under review (and how many more wait: decide these first), with the people the application named besides the first Owner (an approval makes each an invited seat
//                                       that needs no second person at its first enrolment), and a warning line when a wallet the application named was refused as listed; then "Reviews due, and frozen
//                                       organisations": no screening, the next review passed or within 14 days, or frozen; a frozen one ends with what froze it: "frozen by
//                                       <action> (<detail>) on <day>" (screening.attempt: a member proved a wallet that is on a loaded list; the detail is the address)
//   node scripts/operator.mjs decide <organisation id> approve --submission <the 16 characters "list" printed> --tier standard --source registry --evidence "<reference>" --sha256 <64 hex> --next-review 2027-11-11
//                                                              --screening clear --list eu=<file> [--list un=<file>] [--list ofac=<file>]
//   node scripts/operator.mjs decide <organisation id> more|refuse --reason <code> --tier standard --source registry [--screening clear|review|hit --list eu=<file> ...]
//   node scripts/operator.mjs screen <organisation id> --outcome clear|review|hit --list eu=<file> [--list un=<file>] [--list ofac=<file>] --next-review 2027-11-11 [--tier standard --source registry]
//                                       the result of a search made offline, for an active or a frozen organisation. "review" and "hit" freeze it. --tier and --source: only for an organisation with no record yet (a local seed)
//   node scripts/operator.mjs addresses <code>=<file>   loads the wallet addresses of a list file (every 0x and 40 hex characters), in place of that list's earlier ones; prints each organisation that holds one, frozen if it was active
//   node scripts/operator.mjs sync      M10: reads the OFAC list file now (SANCTIONS_URL), as the daily run does: loaded, the same, held (older, shrunk, grown, manual: not loaded;
//                                       compare it, then load the official SDN.XML by hand with "addresses"), or not readable. Whatever the file gives, an organisation whose
//                                       freeze failed before, or that a load left for later, is frozen now (5 a run) and printed. "list" ends with one line per loaded list and a WARNING when one is held or stale
//   node scripts/operator.mjs freeze|unfreeze <organisation id>        an unfreeze is refused while the newest screening says "review" or "hit", or a linked or pending wallet is on a loaded list
//   node scripts/operator.mjs items <organisation id>                  the sealed items of an organisation: id, kind, size, date, SHA-256, key
//   node scripts/operator.mjs get <item id> --reason <code> --out <file>   the item, still sealed; the reason goes into the client's audit log
// Reasons of "get": kyb_review, periodic_review, authority_request, client_request, incident. The file is opened offline (README).
// Reasons: entity_not_found, details_differ, authority_unclear, wallet_differs, declaration_needed, not_eligible.
// Sources: registry, gleif, supervisor_register, declaration. Tiers: standard, enhanced.
// Sanctions screening (README, "Screening, step by step"): "--list code=file" names a list file on this machine (codes eu, un, ofac; eu in every
// screening). The file is read here and only its SHA-256 is sent. The file, the names searched and what was found never leave this machine.
// The command sets nothing else: the API takes no passkey, no member and no wallet address of a client.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { parseArgs } from 'node:util'
import { addressesIn, publishedIn } from './ofac-list.mjs' // the one address rule and the one reader of the publish date, shared with the maker of the list file

const HOST = 'operator.localhost:8787' // the Worker decides by this name; the connection goes to 127.0.0.1
const { positionals: [command, id, decision], values } = parseArgs({
  allowPositionals: true,
  options: {
    tier: { type: 'string' }, source: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' }, sha256: { type: 'string' }, 'next-review': { type: 'string' }, submission: { type: 'string' }, out: { type: 'string' },
    screening: { type: 'string' }, outcome: { type: 'string' }, list: { type: 'string', multiple: true },
  },
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
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
        const bytes = Buffer.concat(chunks)
        let answer = null
        try {
          answer = JSON.parse(bytes.toString('utf8'))
        } catch {
          // not JSON: a sealed file, or a host that is not the operator's answers "Not found"
        }
        resolve({ status: response.statusCode, body: answer, bytes, sha256: response.headers['x-sha256'], key: response.headers['x-seal-key'] })
      })
    }).on('error', reject).end(text)
  })
}
// Review of 5b: asked before anything else. A download is a row in the client's audit log: none for bytes that would be thrown away.
if (command === 'get' && values.out && existsSync(values.out)) {
  console.error(`Refused: the file exists (${values.out}). Nothing was asked. Name another file.`)
  process.exit(1)
}
// Sanctions screening. "code=file": the file is read on this machine. What is sent is its SHA-256 and, for "addresses", the addresses found in it.
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')
function fileOf(pair) {
  const [, code, path] = /^([a-z]+)=(.+)$/.exec(pair ?? '') ?? []
  try {
    return [code, readFileSync(path)]
  } catch {
    console.error(`Refused: ${code ? `the file could not be read (${path})` : 'a list is given as code=file, for example eu=eu-list.xml'}. Nothing was sent.`)
    process.exit(1)
  }
}
const files = (values.list ?? []).map(fileOf)
if (new Set(files.map(([code]) => code)).size !== files.length) {
  console.error('Refused: a list code is given twice. Nothing was sent.')
  process.exit(1)
}
const lists = files.length ? Object.fromEntries(files.map(([code, bytes]) => [code, sha256Of(bytes)])) : undefined
// What the server would refuse or drop, said here in one sentence, before anything is sent.
const unsent = command === 'screen' && !['clear', 'review', 'hit'].includes(values.outcome) ? '"screen" needs --outcome clear, review or hit'
  : command === 'screen' && !lists?.eu ? '"screen" needs --list eu=<file>: the EU list is in every screening'
  : command === 'decide' && lists && !values.screening ? '--list needs --screening clear, review or hit'
  : null
if (unsent) {
  console.error(`Refused: ${unsent}. Nothing was sent.`)
  process.exit(1)
}
// "addresses": every 0x followed by exactly 40 hex characters, in lower case, each once. A file with none is refused here: a load is never empty.
let load
if (command === 'addresses') {
  const [list, bytes] = fileOf(id)
  const text = bytes.toString('latin1')
  const addresses = addressesIn(text)
  if (!addresses.length) {
    console.error('Refused: no address (0x and 40 hex characters) was found in that file. Nothing was sent: the loaded list stays as it is.')
    process.exit(1)
  }
  // The publish day of an official XML goes with it: the console then knows which file is newer, and its own daily read never rolls this load back.
  load = { list, sha256: sha256Of(bytes), addresses, published: publishedIn(text) ?? undefined }
}
const base = '/api/operator/organisations'
// Review of 5b: an id is 32 hex characters, as the server makes them. Anything else never becomes a path: ".." would name another route.
const answer = load ? await call('POST', '/api/operator/sanctions', load)
  : id !== undefined && !/^[0-9a-f]{32}$/.test(id) ? null
  : command === 'list' ? await call('GET', base)
  : command === 'invite' ? await call('POST', '/api/operator/invites', {})
  : command === 'sync' ? await call('POST', '/api/operator/sanctions/sync', {})
  : command === 'decide' && id && decision ? await call('POST', `${base}/${id}/decision`, { decision, tier: values.tier, source: values.source, reason: values.reason, evidenceRef: values.evidence, evidenceSha256: values.sha256, nextReview: values['next-review'], submission: values.submission, screening: values.screening && { outcome: values.screening, lists } })
  : command === 'screen' && id ? await call('POST', `${base}/${id}/screening`, { outcome: values.outcome, lists, nextReview: values['next-review'], tier: values.tier, source: values.source })
  : (command === 'freeze' || command === 'unfreeze') && id ? await call('POST', `${base}/${id}/${command}`, {})
  : command === 'items' && id ? await call('GET', `${base}/${id}/items`)
  : command === 'get' && id && values.reason && values.out ? await call('POST', `/api/operator/items/${id}/download`, { reason: values.reason })
  : null
if (!answer) {
  console.error('usage: node scripts/operator.mjs invite | list | decide <id> approve|more|refuse [--submission --tier --source --reason --evidence --sha256 --next-review --screening clear|review|hit --list eu=<file> --list un=<file> --list ofac=<file>]'
    + ' | sync | screen <id> --outcome clear|review|hit --list eu=<file> [--list un=<file>] [--list ofac=<file>] --next-review YYYY-MM-DD [--tier --source] | addresses eu|un|ofac=<file> | freeze <id> | unfreeze <id> | items <id>'
    + ' | get <item id> --reason kyb_review|periodic_review|authority_request|client_request|incident --out <file>')
  process.exit(1)
}
if (answer.status !== 200) {
  const WHY = {
    submission_changed: 'the organisation changed and was submitted again since that list. Run "list" and compare again.',
    screening_required: 'an approval needs --screening clear and --list eu=<file>.',
    screening_not_clear: 'the screening does not say "clear" (an approval: the one given; an unfreeze: the newest one recorded).',
    wallet_listed: 'a linked or pending wallet of the organisation is on a loaded address list.',
    no_record: 'the organisation has no record to copy from: give --tier and --source.',
  }
  const error = load && answer.status === 500 ? 'The list may be loaded. Run the same command again.' : answer.body?.error // the second step, the freezes, did not finish
  console.error(`Refused (${answer.status}): ${error ? `${error}${WHY[error] ? `: ${WHY[error]}` : ''}` : 'no answer from the operator API: is "pnpm dev" running?'}`)
  process.exit(1)
}
// Why a list file that was read is not loaded, and what ends it.
// The override names the official SDN.XML: the maker's JSON loaded by hand gives a list with no day, which then holds every read as "manual".
const BY_HAND = 'load the official SDN.XML by hand: addresses ofac=<SDN.XML>'
const HELD = {
  older: `it is not newer than the loaded list: a day before, or the same day with other addresses (a correction of that day). Compare it. If the loaded list is right, a newer file ends this. Else ${BY_HAND}`,
  shrunk: `addresses of the loaded list are not in it, and a removal waits for a person. Compare it. If it is right, ${BY_HAND}`,
  grown: `the new addresses in it are over a fifth of the loaded list. Compare it. If it is right, ${BY_HAND}`,
  manual: `the loaded list was loaded by hand from a file with no publish date, and the list file never replaces such a list. To end this, ${BY_HAND}`,
}
const count = (n) => `${n} ${n === 1 ? 'address' : 'addresses'}`
const hitLines = (hits) => (hits.length ? hits.map((h) => `HIT  ${h.id}  ${h.name}  was ${h.state}  ${h.address}  ${h.frozen ? 'frozen now' : h.later ? 'frozen at the next run: run "sync" to do it now' : 'not changed'}`).join('\n') : 'No linked or pending wallet is on a loaded list.')
const sealed = (i) => `${i.id}  ${i.kind}  ${i.size} bytes  ${new Date(i.at).toISOString()}  sha256 ${i.sha256}  sealed to key ${i.key.slice(0, 16)} (${i.generation})`
if (command === 'items') console.log(answer.body.items.length ? answer.body.items.map(sealed).join('\n') : 'No sealed item.')
else if (command === 'get') {
  // The hash is computed here again and compared with the server's: a file that differs is not written.
  const sha256 = createHash('sha256').update(answer.bytes).digest('hex')
  if (sha256 !== answer.sha256) {
    console.error('Refused: the file received does not have the SHA-256 the server recorded. Nothing was written.')
    process.exit(1)
  }
  writeFileSync(values.out, answer.bytes, { mode: 0o600, flag: 'wx' }) // never over an existing file
  console.log(`Written, still sealed: ${values.out}\n${answer.bytes.length} bytes  sha256 ${sha256}  sealed to key ${answer.key.slice(0, 16)}\nThe download is in the organisation's audit log, with the reason "${values.reason}". Open it offline: see README, "Sealed declaration".`)
} else if (command === 'invite') console.log(`Application code, one use, valid until ${new Date(answer.body.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC:\n${answer.body.code}`)
else if (load) {
  console.log(`Loaded ${count(answer.body.entries)} of the list "${answer.body.list}" (file SHA-256 ${load.sha256}).`)
  console.log(hitLines(answer.body.hits))
} else if (command === 'sync') {
  const read = answer.body
  console.log(read.outcome === 'loaded' ? `Loaded ${count(read.entries)} of the list "ofac", published ${read.published}.\n${hitLines(read.hits)}`
    : read.outcome === 'same' ? 'The list file is the one already loaded. The list did not change.'
    : read.outcome === 'held' ? `WARNING  held (${read.reason}): the list file was not loaded: ${HELD[read.reason]}.`
    : read.outcome === 'unavailable' ? 'WARNING  the list file could not be read, or is not what it must be, or SANCTIONS_URL is not an address the console takes (https). The loaded lists did not change.'
    : 'SANCTIONS_URL is not set: there is no list file to read.')
  if (read.outcome !== 'loaded' && read.hits) console.log(hitLines(read.hits)) // a freeze that failed before, or one a load left for later, made now
} else if (command !== 'list') console.log(`Done: ${id} is now ${answer.body.state}.`)
else {
  if (!answer.body.organisations.length) console.log('Nothing is under review.')
  if (answer.body.more) console.log(`${answer.body.more} more under review: decide these first, then list again.`)
  for (const o of answer.body.organisations) {
    console.log([
      `${o.id}  ${o.legalName} (${o.kind}, ${o.country}, ${o.registration})`,
      `  domain          ${o.domain}`,
      `  submitted       ${new Date(o.submittedAt).toISOString()}   submission ${o.submission} (name it in "approve": a change and a new submit make another)`,
      `  first Owner     passkey hash ${o.credentialHash}`,
      ...(o.people.length ? o.people.map((p) => `  person          ${p.name}, ${p.role}, ${p.email}`) : ['  people          none besides the first Owner']),
      `  recovery wallet ${o.wallet ? `${o.wallet.address} on ${o.wallet.chain}, ${o.wallet.kind}${o.wallet.threshold ? ` ${o.wallet.threshold} of ${o.wallet.owners}` : ''}, ${o.wallet.colour.level}${o.wallet.colour.why ? ` (${o.wallet.colour.why})` : ''}` : 'none: a second Owner with two passkeys'}`,
      `  declaration     ${o.declaration ? sealed(o.declaration) : 'none'}`,
      ...(o.refused.length ? [`  WARNING         listed wallet refused: ${o.refused.join(', ')}`] : []),
      `  ready           ${o.missing ? `no: ${o.missing}` : 'yes'}`,
    ].join('\n'))
  }
  // The calendar is a manual chore: this is the list to work through.
  const day = (time) => (time ? new Date(time).toISOString().slice(0, 10) : 'none')
  console.log(!answer.body.reviews.length ? 'No review is due, and no organisation is frozen.' : `Reviews due, and frozen organisations (no screening, the next review passed or within 14 days, or frozen):\n${answer.body.reviews
    .map((r) => `${r.id}  ${r.name}  ${r.state}  last screening ${r.outcome ? `${r.outcome} on ${day(r.screenedAt)}` : 'none'}  next review ${day(r.nextReview)}${r.lastAction ? `  frozen by ${r.lastAction}${r.lastDetail ? ` (${r.lastDetail})` : ''} on ${day(r.lastAt)}` : ''}`).join('\n')}`)
  // M10: the loaded lists. A feed that stops, or a file that was not loaded, must be seen here.
  for (const l of answer.body.lists) {
    console.log(`LIST  ${l.list}  ${count(l.entries)}  published ${l.published ?? 'not known'}  loaded ${day(l.loadedAt)}  last good read of the list file ${day(l.checkedAt)}  file made ${day(l.madeAt)}`)
    if (l.held) console.log(`WARNING  held (${l.held}): the list file read last was not loaded: ${HELD[l.held]}.${l.heldAdds === 0 ? ' It only removes addresses: the desk goes on with the loaded list.' : ' It has addresses the loaded list lacks: the desk sends no order meanwhile.'}`)
    if (l.stale) console.log('WARNING  no good read of the list file for 3 days or more, or the file read was made 3 days ago or more: the loaded list may be out of date. Run "sync", and check that the maker still runs.')
  }
}
