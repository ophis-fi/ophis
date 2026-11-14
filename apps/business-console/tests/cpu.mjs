// The CPU time of the heavy pure-JS steps, timed in Node: pnpm test:cpu. A PROXY, not the Workers meter: the Free plan
// gives 10 ms of CPU per request and per cron run (ARCHITECTURE.md, "Free plan"), measured on Cloudflare's machines.
// Each step runs 200 times after a warm-up; the line gives the CPU time of one run (user + system, process.cpuUsage).
// The heaviest invocation of each kind is then added up from its steps, and the script fails when one passes 10 ms here.
import { encodeFunctionResult, parseAbi } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { signedByKey, verifyDigest } from '../src/server/chain.ts'
import * as data from '../src/server/data.ts'
import { MAX_ADDRESSES, sync } from '../src/server/onboarding.ts'
import { configFor, newChallenge, seal, unseal, verifyAssertion, verifyRegistration } from '../src/server/passkeys.ts'
import { softwareAuthenticator } from './authenticator.ts'

const RUNS = 200
async function cpu(name, step) {
  for (let i = 0; i < 20; i++) await step()
  const start = process.cpuUsage()
  for (let i = 0; i < RUNS; i++) await step()
  const used = process.cpuUsage(start)
  const ms = (used.user + used.system) / 1000 / RUNS
  console.log(`${name.padEnd(58)} ${ms.toFixed(3)} ms`)
  return ms
}

const config = configFor('local')
const KEY = 'k'.repeat(64)
const account = mnemonicToAccount('test test test test test test test test test test test junk')
const digest = `0x${'ab'.repeat(32)}`
const signature = await account.sign({ hash: digest })
// The ERC-1271 path: a signature that is not 65 bytes, so no recovery; both endpoints answer the magic value at once.
const MAGIC = encodeFunctionResult({ abi: parseAbi(['function isValidSignature(bytes32, bytes) view returns (bytes4)']), functionName: 'isValidSignature', result: '0x1626ba7e' })
// The list file: what the daily run reads. The ERC-1271 path: both endpoints answer the magic value at once.
let listFile = ''
globalThis.fetch = async (url, init) => (String(url).endsWith('/ofac.json') ? new Response(listFile) : Response.json({ jsonrpc: '2.0', id: 1, result: JSON.parse(init.body).method === 'eth_chainId' ? '0xa' : MAGIC }))
const key = await softwareAuthenticator({ origin: config.origin, rpId: config.rpId })
const challenge = await newChallenge(KEY, 'signin', '', Date.now())
const registration = await key.register({ challenge, user: { id: 'seat' } })
const stored = await verifyRegistration(config, registration, async () => true)
const assertion = await key.authenticate({ challenge })
const sealed = await seal(KEY, 'wallet-intent', { org: 'a'.repeat(32), seat: 'b'.repeat(32), chainId: 10, wallet: account.address, nonce: `0x${'1'.repeat(64)}` })
// An audit chain of 10,000 rows, hashed as data.ts hashes them, and a check state half way: a load of the audit page
// verifies NEW_ROWS rows after the checkpoint and re-checks OLD_ROWS before it, the most it ever hashes. The fake
// database answers each statement from these rows and never moves the state, so every run does that whole work.
const ROWS = 10_000
const chainRows = []
for (let seq = 1, prev = '0'.repeat(64); seq <= ROWS; seq++) {
  const row = { org_id: 'o'.repeat(32), seq, at: seq, actor_kind: 'seat', actor_id: 's'.repeat(32), session_id: 'x'.repeat(32), action: 'session.create', subject_id: 'c'.repeat(43), detail: null, country: 'LU', asn: 1, prev_hash: prev }
  prev = await data.sha256Hex(JSON.stringify([row.org_id, row.seq, row.at, row.actor_kind, row.actor_id, row.session_id, row.action, row.subject_id, row.detail, row.country, row.asn, row.prev_hash]))
  chainRows.push({ ...row, hash: prev })
}
const CHECKED = ROWS / 2
const state = { checked_seq: CHECKED, checked_hash: chainRows[CHECKED - 1].hash, recheck_seq: 1000, recheck_hash: chainRows[999].hash, sweep_seq: CHECKED, sweep_hash: chainRows[CHECKED - 1].hash, broken_seq: null }
let hashed = 0
const fakeDb = {
  prepare: (sql) => ({ bind: (...args) => ({
    first: async () => state,
    run: async () => ({ meta: { changes: 1 } }), // the write applied, as D1 answers it
    // The rows after a number (LIMIT), or between two.
    all: async () => {
      const rows = sql.includes('LIMIT') ? chainRows.filter((r) => r.seq > args[1]).slice(0, args[2]) : chainRows.filter((r) => r.seq >= args[1] && r.seq <= args[2])
      hashed += rows.length
      return { results: rows }
    },
  }) }),
  batch: (statements) => Promise.all(statements.map((s) => s.all())),
}
// The daily run on a file of n addresses that is the one already loaded (the usual day: "same"), with a database that answers at once.
async function dailyOf(n) {
  const addresses = Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`)
  const sha256 = 'c'.repeat(64)
  listFile = JSON.stringify({ list: 'ofac', published: '2026-11-09', made: '2026-11-10T09:00:00Z', sha256, count: n, addresses })
  const statement = (sql) => ({ bind: () => statement(sql), run: async () => ({}), first: async () => ({ sha256, entries: n, published: '2026-11-09' }),
    all: async () => ({ results: sql.startsWith('SELECT address FROM sanctioned_addresses') ? addresses.map((address) => ({ address })) : [] }) })
  const env = { DB: { prepare: statement }, ENVIRONMENT: 'local', SANCTIONS_URL: 'https://lists.test/ofac.json' }
  return async () => {
    if ((await sync(env, Date.UTC(2026, 10, 10, 9))).outcome !== 'same') throw new Error('the daily run of this script did not read the file as the same')
  }
}
{
  const chain = await data.verifyAudit(fakeDb, 'o')
  if (!chain.ok || chain.rows !== CHECKED + data.NEW_ROWS || hashed !== data.NEW_ROWS + 1 + data.OLD_ROWS) throw new Error(`the audit rows of this script do not verify as a load does: ${JSON.stringify(chain)}, ${hashed} rows read`)
}

const step = {
  recovery: await cpu('signature recovery (signedByKey)', () => signedByKey(digest, account.address, signature)),
  erc1271: await cpu('ERC-1271 path (verifyDigest, no recovery, fake endpoints)', () => verifyDigest(config.chains[10], 10, digest, account.address, '0x')),
  seal: await cpu('seal + unseal of an intent (HMAC)', async () => unseal(KEY, 'wallet-intent', await seal(KEY, 'wallet-intent', { a: 1 }))),
  sealCheck: await cpu('unseal of an intent (HMAC)', () => unseal(KEY, 'wallet-intent', sealed)),
  assertion: await cpu('passkey assertion (verifyAssertion, ES256)', () => verifyAssertion(config, assertion, { id: stored.id, public_key: stored.publicKey, counter: 0 }, async () => true)),
  registration: await cpu('passkey registration (verifyRegistration, ES256)', () => verifyRegistration(config, registration, async () => true)),
  daily127: await cpu('daily run, a list file of 127 addresses (OFAC EVM today)', await dailyOf(127)),
  dailyMax: await cpu(`daily run, a list file of ${MAX_ADDRESSES.toLocaleString('en')} addresses (the most a load takes)`, await dailyOf(MAX_ADDRESSES)),
  audit: await cpu(`audit page, a chain of ${ROWS.toLocaleString('en')} rows (verifyAudit: ${data.NEW_ROWS} new, ${data.OLD_ROWS} re-checked)`, () => data.verifyAudit(fakeDb, 'o')),
}
// The heaviest invocation of each kind, from its steps. A partner's Overview recovers each linked wallet (partner.ts, at most 10 asked).
const invocations = {
  'POST /api/proof, a key wallet (unseal, recovery)': step.sealCheck + step.recovery,
  'POST /api/proof, a Safe (unseal, recovery tried, ERC-1271)': step.sealCheck + step.recovery + step.erc1271,
  'POST /api/signin/finish (assertion)': step.assertion,
  'POST /api/enrol/finish (registration)': step.registration,
  [`GET /api/audit, a chain of ${ROWS.toLocaleString('en')} rows`]: step.audit,
  'daily run (cron), the OFAC EVM list of today': step.daily127,
}
// proof_by (migration 0016): a link written since then is recovered nowhere on a partner's Overview; a row written before costs one.
console.log(`a partner's Overview, 10 wallets linked before proof_by: ${(10 * step.recovery).toFixed(1)} ms (since proof_by: no recovery)`)
console.log(`a list file of ${MAX_ADDRESSES.toLocaleString('en')} addresses: ${step.dailyMax.toFixed(1)} ms (not a check: the OFAC EVM list holds 127)`)
console.log(`\nper audit row: ${(step.audit * 1000 / (data.NEW_ROWS + data.OLD_ROWS)).toFixed(1)} us; a load hashes ${data.NEW_ROWS + data.OLD_ROWS} rows at most, whatever the length of the chain`)
let failed = false
for (const [name, ms] of Object.entries(invocations)) {
  console.log(`${name.padEnd(58)} ${ms.toFixed(3)} ms${ms > 10 ? '  OVER 10 ms' : ''}`)
  failed ||= ms > 10
}
process.exit(failed ? 1 : 0)
