// Security invariants of milestone 1. Each test here was seen to fail once with its control removed
// (ARCHITECTURE.md, security invariants). Runs in the Workers runtime against a local D1.
import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pageHeaders from '../public/_headers?raw'
import routerSource from '../src/server/index.ts?raw'
import dataSource from '../src/server/data.ts?raw'
import passkeySource from '../src/server/passkeys.ts?raw'
import * as data from '../src/server/data.ts'
import { csvCell, EVENTS, handle, routes, type Env } from '../src/server/index.ts'
import { challengeIsOurs, credentialHash, fromBase64Url, newChallenge, phraseFor, userHandle } from '../src/server/passkeys.ts'
import { WORDS } from '../src/server/words.ts'
import { softwareAuthenticator } from './authenticator.ts'

const SITE = { origin: 'http://localhost:8787', rpId: 'localhost' }
const MIN = 60_000
const START = Date.UTC(2026, 10, 10, 9)
const TABLES = ['approvals', 'audit_log', 'credentials', 'enrolment_tickets', 'kyb_records', 'organisations', 'recovery_requests', 'sealed_items', 'seats', 'sessions', 'wallets']
const db = env.DB
// The challenge key is made per run: no secret lives in the repository.
const testEnv = { DB: db, ENVIRONMENT: 'local', CHALLENGE_KEY: crypto.randomUUID() + crypto.randomUUID() } as Env
let now = START

beforeAll(() => applyD1Migrations(db, env.MIGRATIONS))
beforeEach(() => {
  now = START
})

type Key = Awaited<ReturnType<typeof softwareAuthenticator>>
type Answer = Parameters<Key['authenticate']>[1]
interface Options { cookie?: string; body?: unknown; headers?: Record<string, string | null>; env?: Env }

async function call(method: string, path: string, options: Options = {}) {
  const headers = new Headers({ 'sec-fetch-site': 'same-origin' })
  if (method === 'POST') {
    headers.set('origin', SITE.origin)
    headers.set('content-type', 'application/json')
  }
  if (options.cookie) headers.set('cookie', options.cookie)
  for (const [name, value] of Object.entries(options.headers ?? {})) value === null ? headers.delete(name) : headers.set(name, value)
  const body = method === 'POST' ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {})) : undefined
  const response = await handle(new Request(SITE.origin + path, { method, headers, body }), options.env ?? testEnv, () => now)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, headers: response.headers, body: (await response.json()) as any }
}

async function organisation(name = 'Northwind Vaults') {
  const ticket = data.randomToken()
  const ids = await data.seedOrganisation(db, { name, kind: 'partner', ownerName: `Owner of ${name}`, ticketHash: await data.sha256Hex(ticket), now })
  return { ...ids, name, ticket }
}
// A ticket and a second seat, written straight to the tables: issuing tickets is milestone 2.
async function ticketFor(orgId: string, seatId: string, role: string, kind: string, issuerSeatId: string) {
  const ticket = data.randomToken()
  await db
    .prepare(`INSERT INTO enrolment_tickets (id, org_id, seat_id, kind, role, issuer_seat_id, token_hash, nonce, state, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`)
    .bind(data.randomId(), orgId, seatId, kind, role, issuerSeatId, await data.sha256Hex(ticket), data.randomId(), now + 10 * MIN, now)
    .run()
  return ticket
}
async function invite(orgId: string, issuerSeatId: string, role: string) {
  const seatId = data.randomId()
  await db.prepare(`INSERT INTO seats (id, org_id, display_name, role, state, created_at) VALUES (?, ?, ?, ?, 'invited', ?)`).bind(seatId, orgId, `A ${role}`, role, now).run()
  return { seatId, ticket: await ticketFor(orgId, seatId, role, 'invitation', issuerSeatId) }
}
let labels = 0
async function enrol(ticket: string, key: Key, answer: Answer = {}, cookie?: string) {
  const start = await call('POST', '/api/enrol/start', { body: { ticket }, cookie })
  if (start.status !== 200) return start
  return call('POST', '/api/enrol/finish', { body: { ticket, label: `Office key ${++labels}`, response: await key.register(start.body.options, answer) }, cookie })
}
async function signIn(key: Key, answer: Answer = {}) {
  const start = await call('POST', '/api/signin/start')
  const finish = await call('POST', '/api/signin/finish', { body: { response: await key.authenticate(start.body.options, answer) } })
  return { ...finish, cookie: finish.headers.get('set-cookie')?.split(';')[0] ?? '' }
}
// An organisation whose Owner holds an active passkey and a live session.
async function member(name?: string) {
  const org = await organisation(name)
  const key = await softwareAuthenticator(SITE)
  expect((await enrol(org.ticket, key)).status).toBe(200)
  await data.devActivatePending(db, 'local', now)
  const session = await signIn(key)
  expect(session.status).toBe(200)
  const me = await call('GET', '/api/me', { cookie: session.cookie })
  return { ...org, key, cookie: session.cookie, sessionId: me.body.session.id as string }
}
type Member = Awaited<ReturnType<typeof member>>

// ---- milestone 2 helpers: every step goes through the routes ----
const HOUR = 60 * MIN
const WRONG = `${WORDS[1295]} ${WORDS[1294]} ${WORDS[1293]}`
interface Holder { cookie: string }
const post = (path: string, m: Holder, body: unknown = {}) => call('POST', path, { cookie: m.cookie, body })
const cookieOf = (response: { headers: Headers }) => response.headers.get('set-cookie')?.split(';')[0] ?? ''
// A passkey check that renews the 5 minute window. The session gets a new token, so the holder's cookie is replaced.
async function stepUp(m: Holder, key: Key, answer: Answer = {}) {
  const start = await post('/api/stepup/start', m)
  const finish = await post('/api/stepup/finish', m, { response: await key.authenticate(start.body.options, answer) })
  if (finish.status === 200) m.cookie = cookieOf(finish)
  return finish
}
async function addKey(m: Holder, options: { backupEligible?: boolean; counts?: boolean } = {}, answer: Answer = {}) {
  const key = await softwareAuthenticator(SITE, options)
  const start = await post('/api/passkeys/start', m)
  if (start.status !== 200) return { ...start, key }
  return { ...(await post('/api/passkeys/finish', m, { label: `Office key ${++labels}`, response: await key.register(start.body.options, answer) })), key }
}
async function again<T extends Holder & { key: Key }>(m: T) {
  const session = await signIn(m.key)
  expect(session.status).toBe(200)
  m.cookie = session.cookie
  return m
}
// An Owner with two hardware keys: the state in which a seat may do sensitive things.
async function owner(name?: string) {
  const m = await member(name)
  const second = await addKey(m)
  expect(second.status).toBe(200)
  return { ...m, key2: second.key }
}
// A colleague with two active passkeys and a session. Its first passkey is activated by the local command, as
// the first Owner's is; the ceremony itself is what the tests exercise. Call it before a ticket is left pending.
async function colleague(org: { orgId: string; seatId: string }, role: string) {
  const seat = await invite(org.orgId, org.seatId, role)
  const key = await softwareAuthenticator(SITE)
  expect((await enrol(seat.ticket, key)).status).toBe(200)
  await data.devActivatePending(db, 'local', now)
  const m = await again({ orgId: org.orgId, seatId: seat.seatId, key, cookie: '' })
  const second = await addKey(m)
  expect(second.status).toBe(200)
  return { ...m, key2: second.key }
}
const issue = (m: Holder, target: { seatId: string } | { displayName: string; role: string }) => post('/api/tickets', m, target)
// The member's side: opens the link, creates a passkey, sees the three words.
async function enrolLink(link: string, options: { backupEligible?: boolean } = {}) {
  const key = await softwareAuthenticator(SITE, options)
  const done = await enrol(link.split('#/enrol/')[1], key)
  return { ...done, key, words: (done.body.phrase ?? []).join(' ') as string }
}
// The colleague's side: types the words heard, then a passkey check made for this ticket.
async function confirm(m: Holder, ticketId: string, words: string, key: Key, answer: Answer = {}) {
  const start = await post(`/api/tickets/${ticketId}/confirm/start`, m)
  if (start.status !== 200) return start
  return post(`/api/tickets/${ticketId}/confirm`, m, { words, response: await key.authenticate(start.body.options, answer) })
}
// Issue, enrol, and the issuer's confirmation. A Trader or Viewer is active after it; a key role needs `second`.
async function ceremony(issuer: Holder & { key: Key }, target: { seatId: string } | { displayName: string; role: string }, second?: Holder & { key: Key }) {
  const ticket = await issue(issuer, target)
  expect(ticket.status).toBe(200)
  const joined = await enrolLink(ticket.body.link)
  expect(joined.status).toBe(200)
  const first = await confirm(issuer, ticket.body.ticketId, joined.words, issuer.key)
  expect(first.status).toBe(200)
  if (second) expect((await confirm(second, ticket.body.ticketId, joined.words, second.key)).body.state).toBe('active')
  return { ticketId: ticket.body.ticketId as string, seatId: ticket.body.seatId as string, key: joined.key, words: joined.words, state: first.body.state as string, cookie: '' }
}
async function stop(key: Key, answer: Answer = {}) {
  const start = await call('POST', '/api/stop/start')
  return call('POST', '/api/stop/finish', { body: { response: await key.authenticate(start.body.options, answer) } })
}
// ---- milestone 3 helpers ----
const DAY = 24 * HOUR
const act = (m: Holder, seatId: string, what: 'freeze' | 'unfreeze' | 'role' | 'remove', body: unknown = {}) => post(`/api/members/${seatId}/${what}`, m, body)
const decide = (m: Holder, id: string, what: 'approve' | 'reject' | 'cancel') => post(`/api/approvals/${id}/${what}`, m)
// A request made in organisation A about a seat of B: not found, and no row changes anywhere.
async function crossRequest(a: Member, b: Member, what: 'unfreeze' | 'role' | 'remove') {
  await addKey(a)
  if (what === 'unfreeze') await db.prepare(`UPDATE seats SET state = 'frozen' WHERE id = ?`).bind(b.seatId).run()
  const before = await snapshot()
  expect((await act(a, b.seatId, what, { role: 'admin' })).status).toBe(404)
  expect(await snapshot()).toBe(before)
}
// A request that waits in organisation B: a member of A can neither approve, reject nor cancel it.
async function crossDecide(a: Member, b: Member, what: 'approve' | 'reject' | 'cancel') {
  await addKey(b)
  const viewer = await colleague(b, 'viewer')
  const { id } = (await act(b, viewer.seatId, 'role', { role: 'trader' })).body
  await addKey(a)
  const before = await snapshot()
  expect((await decide(a, id, what)).status).toBe(404)
  expect(await snapshot()).toBe(before)
}
// An environment whose database lets a competing write of the same organisation land just before each of
// its next batch() calls: the batch then collides on the audit sequence, exactly as two requests at once do.
const racing = (compete: () => Promise<unknown>, collisions = 1) => ({
  ...testEnv,
  DB: new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (property !== 'batch') return typeof value === 'function' ? value.bind(target) : value
      return async (statements: D1PreparedStatement[]) => {
        if (collisions-- > 0) await compete()
        return target.batch(statements)
      }
    },
  }),
})
const row = <T = Record<string, unknown>>(sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).first<T>()
const credentialState = async (key: Key) => (await row<{ state: string }>('SELECT state FROM credentials WHERE id = ?', key.id))?.state

const count = async (table: string, orgId: string) =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE org_id = ?`).bind(orgId).first<{ n: number }>())!.n
async function snapshot(tables = TABLES) {
  const rows: Record<string, unknown> = {}
  for (const table of tables) rows[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results
  return JSON.stringify(rows)
}
async function withTrigger(event: string, run: () => Promise<void>) {
  await db.prepare(`CREATE TRIGGER test_block BEFORE ${event} BEGIN SELECT RAISE(ABORT, 'blocked by the test'); END`).run()
  try {
    await run()
  } finally {
    await db.prepare('DROP TRIGGER test_block').run()
  }
}

describe('a. a passkey answers for this site only', () => {
  it('rejects an assertion made for another origin', async () => {
    const m = await member()
    const result = await signIn(m.key, { as: { origin: 'https://localhost.evil.example' } })
    expect(result.status).toBe(401)
    expect(result.headers.get('set-cookie')).toBeNull()
  })
  it('rejects an assertion made for another relying-party id', async () => {
    const m = await member()
    expect((await signIn(m.key, { as: { rpId: 'ophis.fi' } })).status).toBe(401)
    expect((await signIn(m.key)).status).toBe(200)
  })
  it('rejects an assertion without user verification', async () => {
    const m = await member()
    expect((await signIn(m.key, { userVerified: false })).status).toBe(401)
  })
  it('rejects a registration made for another origin, relying party, or without user verification', async () => {
    const org = await organisation()
    for (const answer of [{ as: { origin: 'https://evil.example' } }, { as: { rpId: 'ophis.fi' } }, { userVerified: false }]) {
      expect((await enrol(org.ticket, await softwareAuthenticator(SITE), answer)).status).toBe(400)
    }
    expect(await count('credentials', org.orgId)).toBe(0)
  })
  it('rejects a challenge after 5 minutes', async () => {
    const m = await member()
    const start = await call('POST', '/api/signin/start')
    const response = await m.key.authenticate(start.body.options)
    now += 5 * MIN + 1
    expect((await call('POST', '/api/signin/finish', { body: { response } })).status).toBe(401)
  })
  it('judges expiry when the body has arrived, not when the request began', async () => {
    const m = await member()
    const start = await call('POST', '/api/signin/start')
    const text = JSON.stringify({ response: await m.key.authenticate(start.body.options) })
    // A slow sender: the clock passes the challenge's 5 minutes while the body is still on its way.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        now += 5 * MIN + 1
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }, { highWaterMark: 0 })
    const headers = { 'sec-fetch-site': 'same-origin', origin: SITE.origin, 'content-type': 'application/json' }
    const response = await handle(new Request(`${SITE.origin}/api/signin/finish`, { method: 'POST', body, headers }), testEnv, () => now)
    expect(now).toBe(START + 5 * MIN + 1)
    expect(response.status).toBe(401)
  })
  it('refuses a passkey whose counter goes backwards (a copied key), and the stored counter never goes down', async () => {
    const m = await member() // counter 1 at enrolment, 2 at sign-in
    expect((await signIn(m.key)).status).toBe(200) // 3
    expect((await signIn(m.key, { counter: 2 })).status).toBe(401)
    const stored = () => db.prepare('SELECT counter FROM credentials WHERE id = ?').bind(m.key.id).first<{ counter: number }>()
    expect((await stored())!.counter).toBe(3)
    // Two sign-ins verified at the same moment commit out of order: the lower counter must not win.
    await data.createSession(db, { orgId: m.orgId, seatId: m.seatId, credentialId: m.key.id, counter: 2, tokenHash: data.randomId(), challengeHash: data.randomId(), now, userAgent: null, country: null, asn: null })
    expect((await stored())!.counter).toBe(3)
  })
  it('rejects a challenge it did not issue', async () => {
    const m = await member()
    const start = await call('POST', '/api/signin/start', { env: { ...testEnv, CHALLENGE_KEY: 'another key, another key, another key!' } })
    expect((await call('POST', '/api/signin/finish', { body: { response: await m.key.authenticate(start.body.options) } })).status).toBe(401)
  })
  it('opens one session per assertion: a replay is refused', async () => {
    // counts: false is a passkey whose counter stays 0, as most do. Only the recorded challenge stops the replay.
    const org = await organisation()
    const key = await softwareAuthenticator(SITE, { counts: false })
    await enrol(org.ticket, key)
    await data.devActivatePending(db, 'local', now)
    const start = await call('POST', '/api/signin/start')
    const response = await key.authenticate(start.body.options)
    expect((await call('POST', '/api/signin/finish', { body: { response } })).status).toBe(200)
    expect((await call('POST', '/api/signin/finish', { body: { response } })).status).toBe(401)
    expect(await count('sessions', org.orgId)).toBe(1)
  })
})

describe('b. only an active credential signs in', () => {
  it('a pending credential cannot sign in', async () => {
    const org = await organisation()
    const key = await softwareAuthenticator(SITE)
    const stored = await enrol(org.ticket, key)
    expect(stored.status).toBe(200)
    expect(stored.body.state).toBe('pending')
    expect((await signIn(key)).status).toBe(401)
    expect(await count('sessions', org.orgId)).toBe(0)
    // The same on a seat that is already active: a member's new passkey waits for its confirmation.
    const m = await member()
    const second = await softwareAuthenticator(SITE)
    expect((await enrol(await ticketFor(m.orgId, m.seatId, 'owner', 're_enrolment', m.seatId), second)).status).toBe(200)
    expect((await signIn(second)).status).toBe(401)
    expect((await signIn(m.key)).status).toBe(200)
  })
  it('a suspended or revoked credential cannot sign in, and its session ends', async () => {
    const m = await member()
    for (const state of ['suspended', 'revoked']) {
      await db.prepare('UPDATE credentials SET state = ? WHERE id = ?').bind(state, m.key.id).run()
      expect((await signIn(m.key)).status).toBe(401)
      expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
    }
    await db.prepare(`UPDATE credentials SET state = 'active' WHERE id = ?`).bind(m.key.id).run()
    expect((await signIn(m.key)).status).toBe(200)
  })
  it('a frozen seat or a frozen organisation cannot sign in', async () => {
    const m = await member()
    await db.prepare(`UPDATE seats SET state = 'frozen' WHERE id = ?`).bind(m.seatId).run()
    const frozen = await signIn(m.key) // told that the seat is frozen (section t), and given no session
    expect([frozen.status, frozen.body.error, frozen.cookie]).toEqual([403, 'seat_frozen', ''])
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
    await db.prepare(`UPDATE seats SET state = 'active' WHERE id = ?`).bind(m.seatId).run()
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    await db.prepare(`UPDATE organisations SET state = 'frozen' WHERE id = ?`).bind(m.orgId).run()
    expect((await signIn(m.key)).status).toBe(401)
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
  })
  it('an Owner cannot enrol a synced passkey; a Viewer can', async () => {
    const org = await organisation()
    const synced = await softwareAuthenticator(SITE, { backupEligible: true })
    const refused = await enrol(org.ticket, synced)
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('device_bound_required')
    expect(await count('credentials', org.orgId)).toBe(0)
    // The tickets below name the Owner as issuer, and a ticket is dead unless its issuer's seat is active.
    await db.prepare(`UPDATE seats SET state = 'active' WHERE id = ?`).bind(org.seatId).run()
    const viewer = await invite(org.orgId, org.seatId, 'viewer')
    expect((await enrol(viewer.ticket, synced)).status).toBe(200)
    // An Admin may, once the organisation allows synced keys. An Owner never may.
    const admin = await invite(org.orgId, org.seatId, 'admin')
    const second = await softwareAuthenticator(SITE, { backupEligible: true })
    expect((await enrol(admin.ticket, second)).body.error).toBe('device_bound_required')
    await db.prepare('UPDATE organisations SET synced_keys_allowed = 1 WHERE id = ?').bind(org.orgId).run()
    expect((await enrol(org.ticket, second)).body.error).toBe('device_bound_required')
    expect((await enrol(admin.ticket, second)).status).toBe(200)
  })
  it('the seat decides the key rule: a ticket that names another role than its seat is dead', async () => {
    const org = await organisation()
    const ticket = await ticketFor(org.orgId, org.seatId, 'viewer', 're_enrolment', org.seatId)
    expect((await enrol(ticket, await softwareAuthenticator(SITE, { backupEligible: true }))).status).toBe(404)
    expect(await count('credentials', org.orgId)).toBe(0)
  })
  it('a ticket is dead once its seat is removed or its organisation frozen', async () => {
    const org = await organisation()
    const seat = await invite(org.orgId, org.seatId, 'viewer')
    await db.prepare(`UPDATE seats SET state = 'removed' WHERE id = ?`).bind(seat.seatId).run()
    expect((await enrol(seat.ticket, await softwareAuthenticator(SITE))).status).toBe(404)
    await db.prepare(`UPDATE organisations SET state = 'frozen' WHERE id = ?`).bind(org.orgId).run()
    expect((await enrol(org.ticket, await softwareAuthenticator(SITE))).status).toBe(404)
    expect(await count('credentials', org.orgId)).toBe(0)
  })
  it('a key label is short plain text', async () => {
    const org = await organisation()
    const key = await softwareAuthenticator(SITE)
    for (const label of ['', '<b>key</b>', 'x'.repeat(41), 7]) {
      const start = await call('POST', '/api/enrol/start', { body: { ticket: org.ticket } })
      const finish = await call('POST', '/api/enrol/finish', { body: { ticket: org.ticket, label, response: await key.register(start.body.options) } })
      expect(finish.body).toEqual({ error: 'label_invalid' })
    }
    expect(await count('credentials', org.orgId)).toBe(0)
  })
  it('a ticket stores one credential, once', async () => {
    const org = await organisation()
    expect((await enrol(org.ticket, await softwareAuthenticator(SITE))).status).toBe(200)
    expect((await enrol(org.ticket, await softwareAuthenticator(SITE))).status).toBe(404)
    expect(await count('credentials', org.orgId)).toBe(1)
  })
  it('a key-role ticket is dead after 10 minutes, at start and at finish', async () => {
    const org = await organisation()
    const key = await softwareAuthenticator(SITE)
    const start = await call('POST', '/api/enrol/start', { body: { ticket: org.ticket } })
    expect(start.status).toBe(200)
    now += 10 * MIN + 1
    expect((await call('POST', '/api/enrol/start', { body: { ticket: org.ticket } })).status).toBe(404)
    now = START + 6 * MIN // a challenge that is still valid at 10 minutes, so only the ticket's age can refuse the finish
    const fresh = await call('POST', '/api/enrol/start', { body: { ticket: org.ticket } })
    now = START + 10 * MIN + 1
    const finish = await call('POST', '/api/enrol/finish', { body: { ticket: org.ticket, label: 'Office key 1', response: await key.register(fresh.body.options) } })
    expect(finish.status).toBe(404)
    expect(await count('credentials', org.orgId)).toBe(0)
  })
  it('activation by command refuses anything but the local database', async () => {
    const org = await organisation()
    await enrol(org.ticket, await softwareAuthenticator(SITE))
    await expect(data.devActivatePending(db, 'production', now)).rejects.toThrow(/local/)
    const row = await db.prepare('SELECT state FROM credentials WHERE org_id = ?').bind(org.orgId).first<{ state: string }>()
    expect(row!.state).toBe('pending')
  })
})

describe('c. sessions', () => {
  it('the cookie carries every required attribute and the database holds only its hash', async () => {
    const org = await organisation()
    const key = await softwareAuthenticator(SITE)
    await enrol(org.ticket, key)
    await data.devActivatePending(db, 'local', now)
    const setCookie = (await signIn(key)).headers.get('set-cookie')!
    expect(setCookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/)
    expect(setCookie).not.toMatch(/domain/i)
    const token = setCookie.slice('__Host-session='.length, setCookie.indexOf(';'))
    const row = await db.prepare('SELECT * FROM sessions WHERE org_id = ?').bind(org.orgId).first<Record<string, unknown>>()
    expect(row!.token_hash).toBe(await data.sha256Hex(token))
    expect(JSON.stringify(row)).not.toContain(token)
  })
  it('a revoked session fails on the next request', async () => {
    const m = await member()
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    const revoke = await call('POST', `/api/sessions/${m.sessionId}/revoke`, { cookie: m.cookie })
    expect(revoke.status).toBe(200)
    expect(revoke.headers.get('set-cookie')).toMatch(/^__Host-session=; .*Max-Age=0$/)
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
    expect((await call('GET', '/api/org', { cookie: m.cookie })).status).toBe(401)
  })
  it('sign-out ends the session and clears the cookie', async () => {
    const m = await member()
    const out = await call('POST', '/api/signout', { cookie: m.cookie })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toBe('__Host-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0')
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
  })
  it('a session ends after 15 minutes idle', async () => {
    const m = await member()
    now += 14 * MIN
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    now += 14 * MIN
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    now += 15 * MIN + 1
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
  })
  it('a session ends 12 hours after sign-in, however active it is', async () => {
    const m = await member()
    for (let step = 0; step < 71; step++) {
      now += 10 * MIN
      expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    }
    now += 10 * MIN + 1
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(401)
  })
  it('the session list shows live sessions only and marks the current one', async () => {
    const m = await member()
    const second = await signIn(m.key)
    await call('POST', '/api/signout', { cookie: second.cookie })
    const ids = async () => (await call('GET', '/api/org', { cookie: m.cookie })).body.sessions.map((s: { id: string }) => s.id)
    expect(await ids()).toEqual([m.sessionId])
    await signIn(m.key) // a third session, left idle past its 15 minutes while the first stays in use
    expect(await ids()).toHaveLength(2)
    now += 10 * MIN
    await call('GET', '/api/me', { cookie: m.cookie })
    now += 6 * MIN
    const org = await call('GET', '/api/org', { cookie: m.cookie })
    expect(org.body.sessions.map((s: { id: string }) => s.id)).toEqual([m.sessionId])
    expect(org.body.currentSessionId).toBe(m.sessionId)
    expect(org.body.members).toHaveLength(1)
    expect(org.body.passkeys).toEqual([expect.objectContaining({ label: expect.stringMatching(/^Office key \d+$/), state: 'active', deviceBound: true })])
  })
})

describe('d. request checks', () => {
  for (const site of ['same-site', 'cross-site', 'none', null]) {
    it(`refuses an API call with Sec-Fetch-Site ${site ?? 'missing'}`, async () => {
      const m = await member()
      const headers = { 'sec-fetch-site': site }
      // The route table decides the list: a route added later is checked without touching this test.
      for (const route of routes) expect((await call(route.method, route.path.replace(':id', m.sessionId), { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    })
  }
  for (const origin of ['https://evil.example', 'http://localhost:8788', 'https://localhost:8787', 'null', null]) {
    it(`refuses a state change with Origin ${origin ?? 'missing'}`, async () => {
      const m = await member()
      const headers = { origin }
      for (const route of routes.filter((r) => r.method === 'POST')) expect((await call('POST', route.path.replace(':id', m.sessionId), { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    })
  }
  it('the expected origin is the configured one, not the host the request arrived on', async () => {
    const elsewhere = 'https://business.evil.example'
    const response = await handle(
      new Request(`${elsewhere}/api/signin/start`, { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'same-origin', origin: elsewhere, 'content-type': 'application/json' } }),
      testEnv,
      () => now,
    )
    expect(response.status).toBe(403)
  })
  it('a state change is a JSON POST: no other method, no other content type', async () => {
    const m = await member()
    expect(routes.filter((route) => route.method !== 'GET').every((route) => route.method === 'POST')).toBe(true)
    expect(routes.filter((route) => route.method === 'GET').map((route) => route.path).sort()).toEqual(['/api/audit', '/api/me', '/api/org'])
    expect((await call('GET', '/api/signout', { cookie: m.cookie })).status).toBe(404)
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expect((await call('POST', '/api/signout', { cookie: m.cookie, headers: { 'content-type': type } })).status).toBe(415)
    }
    expect((await call('POST', '/api/signout', { cookie: m.cookie, body: '[1]' })).status).toBe(400)
    expect((await call('POST', '/api/signout', { cookie: m.cookie, body: '{' })).status).toBe(400)
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
  })
  it('refuses a body over the size cap', async () => {
    expect((await call('POST', '/api/signin/finish', { body: { response: { id: 'x'.repeat(70_000) } } })).status).toBe(413)
  })
  it('grants no CORS access, to a preflight or to a normal call', async () => {
    const preflight = await call('OPTIONS', '/api/me', { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
    expect(preflight.status).toBe(403)
    const ok = await call('POST', '/api/signin/start', { headers: { origin: SITE.origin } })
    for (const response of [preflight, ok]) {
      expect([...response.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])
    }
  })
})

// One case per route. The key is "METHOD path" and must match the route table exactly.
const isolation: Record<string, (a: Member, b: Member) => Promise<void>> = {
  'POST /api/enrol/start': async (a, b) => {
    // A ticket decides the organisation. A's session does not.
    const seat = await invite(b.orgId, b.seatId, 'viewer')
    const start = await call('POST', '/api/enrol/start', { body: { ticket: seat.ticket }, cookie: a.cookie })
    expect(start.body.organisation).toBe(b.name)
    expect(JSON.stringify(start.body)).not.toContain(a.orgId)
    expect(start.body.options.user.id).toBe(userHandle(seat.seatId))
  },
  'POST /api/enrol/finish': async (a, b) => {
    const inA = await invite(a.orgId, a.seatId, 'viewer')
    const inB = await invite(b.orgId, b.seatId, 'viewer')
    const key = await softwareAuthenticator(SITE)
    // A challenge issued for A's ticket does not store a passkey on B's ticket.
    const startA = await call('POST', '/api/enrol/start', { body: { ticket: inA.ticket } })
    const crossed = await call('POST', '/api/enrol/finish', { body: { ticket: inB.ticket, label: 'Key', response: await key.register(startA.body.options) } })
    expect(crossed.status).toBe(400)
    // Enrolled with B's ticket while signed in to A: the passkey belongs to B's seat.
    expect((await enrol(inB.ticket, key, {}, a.cookie)).status).toBe(200)
    const row = await db.prepare('SELECT org_id, seat_id FROM credentials WHERE id = ?').bind(key.id).first()
    expect(row).toEqual({ org_id: b.orgId, seat_id: inB.seatId })
    expect(await count('credentials', a.orgId)).toBe(1)
  },
  'POST /api/signin/start': async (a) => {
    const start = await call('POST', '/api/signin/start', { cookie: a.cookie })
    expect(Object.keys(start.body)).toEqual(['options'])
    expect(Object.keys(start.body.options).sort()).toEqual(['challenge', 'rpId', 'timeout', 'userVerification'])
  },
  'POST /api/signin/finish': async (a, b) => {
    // A passkey of organisation A opens a session in A only, and cannot name a seat of B.
    expect((await signIn(a.key, { userHandle: userHandle(b.seatId) })).status).toBe(401)
    const session = await signIn(a.key)
    const me = await call('GET', '/api/me', { cookie: session.cookie })
    expect(me.body.organisation.id).toBe(a.orgId)
    expect(me.body.seat.id).toBe(a.seatId)
  },
  'GET /api/me': async (a, b) => {
    const me = await call('GET', '/api/me', { cookie: a.cookie })
    expect(me.body.organisation.id).toBe(a.orgId)
    for (const foreign of [b.orgId, b.seatId, b.sessionId, b.name]) expect(JSON.stringify(me.body)).not.toContain(foreign)
  },
  'GET /api/org': async (a, b) => {
    const org = await call('GET', '/api/org', { cookie: a.cookie })
    expect(org.body.members.map((m: { id: string }) => m.id)).toEqual([a.seatId])
    expect(org.body.sessions.map((s: { id: string }) => s.id)).toEqual([a.sessionId])
    expect(org.body.passkeys).toHaveLength(1)
    for (const foreign of [b.orgId, b.seatId, b.sessionId, b.name]) expect(JSON.stringify(org.body)).not.toContain(foreign)
  },
  'POST /api/sessions/:id/revoke': async (a, b) => {
    const before = await count('audit_log', b.orgId)
    const revoke = await call('POST', `/api/sessions/${b.sessionId}/revoke`, { cookie: a.cookie })
    expect(revoke.status).toBe(404)
    expect((await call('GET', '/api/me', { cookie: b.cookie })).status).toBe(200)
    expect(await count('audit_log', b.orgId)).toBe(before)
  },
  'POST /api/signout': async (a, b) => {
    expect((await call('POST', '/api/signout', { cookie: a.cookie })).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: b.cookie })).status).toBe(200)
  },
  'POST /api/stepup/start': async (a, b) => {
    const start = await post('/api/stepup/start', a)
    expect(Object.keys(start.body)).toEqual(['options'])
    expect(start.body.options.allowCredentials).toEqual([{ type: 'public-key', id: a.key.id }])
    // A's challenge is for A's session: it does not pass in B's.
    expect((await post('/api/stepup/finish', b, { response: await b.key.authenticate(start.body.options) })).status).toBe(403)
  },
  'POST /api/stepup/finish': async (a, b) => {
    // A passkey of organisation B does not pass a check in a session of A.
    const before = await count('audit_log', b.orgId)
    const start = await post('/api/stepup/start', a)
    const finish = await post('/api/stepup/finish', a, { response: await b.key.authenticate(start.body.options) })
    expect(finish.status).toBe(403)
    expect(finish.headers.get('set-cookie')).toBeNull()
    expect((await call('GET', '/api/me', { cookie: a.cookie })).body.organisation.id).toBe(a.orgId)
    expect(await count('audit_log', b.orgId)).toBe(before)
  },
  'POST /api/passkeys/start': async (a, b) => {
    const start = await post('/api/passkeys/start', a)
    expect(start.body.options.user.id).toBe(userHandle(a.seatId))
    expect(start.body.options.excludeCredentials).toEqual([{ type: 'public-key', id: a.key.id }])
    for (const foreign of [b.orgId, b.seatId, b.key.id, b.name]) expect(JSON.stringify(start.body)).not.toContain(foreign)
  },
  'POST /api/passkeys/finish': async (a, b) => {
    // A challenge issued in B's session adds no passkey in A's. A passkey added by A belongs to A's seat.
    const theirs = await post('/api/passkeys/start', b)
    const crossed = await post('/api/passkeys/finish', a, { label: 'Key', response: await (await softwareAuthenticator(SITE)).register(theirs.body.options) })
    expect(crossed.body).toEqual({ error: 'passkey_rejected' })
    const added = await addKey(a)
    expect(await row('SELECT org_id, seat_id FROM credentials WHERE id = ?', added.key.id)).toEqual({ org_id: a.orgId, seat_id: a.seatId })
    expect(await count('credentials', b.orgId)).toBe(1)
  },
  'POST /api/passkeys/:id/revoke': async (a, b) => {
    await addKey(a)
    const before = await count('audit_log', b.orgId)
    expect((await post(`/api/passkeys/${b.key.id}/revoke`, a)).status).toBe(404)
    expect(await credentialState(b.key)).toBe('active')
    expect(await count('audit_log', b.orgId)).toBe(before)
  },
  'POST /api/tickets': async (a, b) => {
    await addKey(a)
    const viewer = await invite(b.orgId, b.seatId, 'viewer')
    const tickets = await count('enrolment_tickets', b.orgId)
    expect((await issue(a, { seatId: b.seatId })).status).toBe(404)
    expect((await issue(a, { seatId: viewer.seatId })).status).toBe(404)
    expect(await count('enrolment_tickets', b.orgId)).toBe(tickets)
    const mine = await issue(a, { displayName: 'Ada Viewer', role: 'viewer' })
    expect(await row('SELECT org_id FROM seats WHERE id = ?', mine.body.seatId)).toEqual({ org_id: a.orgId })
    expect(await count('seats', b.orgId)).toBe(2)
  },
  // In the next three, B holds a ticket and A, an Owner with two keys, knows its id and even its words.
  'POST /api/tickets/:id/confirm/start': async (a, b) => {
    await addKey(a)
    await addKey(b)
    const theirs = await issue(b, { displayName: 'Ada Viewer', role: 'viewer' })
    await enrolLink(theirs.body.link)
    expect((await post(`/api/tickets/${theirs.body.ticketId}/confirm/start`, a)).status).toBe(404)
    expect((await post(`/api/tickets/${theirs.body.ticketId}/confirm/start`, b)).status).toBe(200)
  },
  'POST /api/tickets/:id/confirm': async (a, b) => {
    await addKey(a)
    await addKey(b)
    const theirs = await issue(b, { displayName: 'Ada Viewer', role: 'viewer' })
    const joined = await enrolLink(theirs.body.link)
    // A passes a real passkey check for a ticket of its own, and sends it with B's ticket id and B's words.
    const own = await issue(a, { displayName: 'Bea Viewer', role: 'viewer' })
    await enrolLink(own.body.link)
    const start = await post(`/api/tickets/${own.body.ticketId}/confirm/start`, a)
    const crossed = await post(`/api/tickets/${theirs.body.ticketId}/confirm`, a, { words: joined.words, response: await a.key.authenticate(start.body.options) })
    expect(crossed.status).toBe(404)
    expect(await row('SELECT state, attempts FROM enrolment_tickets WHERE id = ?', theirs.body.ticketId)).toEqual({ state: 'stored', attempts: 0 })
    expect(await credentialState(joined.key)).toBe('pending')
  },
  'POST /api/tickets/:id/cancel': async (a, b) => {
    await addKey(a)
    await addKey(b)
    const theirs = await issue(b, { displayName: 'Ada Viewer', role: 'viewer' })
    expect((await post(`/api/tickets/${theirs.body.ticketId}/cancel`, a)).status).toBe(404)
    expect((await enrolLink(theirs.body.link)).status).toBe(200)
  },
  'POST /api/stop/start': async (a) => {
    const start = await call('POST', '/api/stop/start', { cookie: a.cookie })
    expect(Object.keys(start.body)).toEqual(['options'])
    expect(Object.keys(start.body.options).sort()).toEqual(['challenge', 'rpId', 'timeout', 'userVerification'])
  },
  'POST /api/stop/finish': async (a, b) => {
    // A replaced passkey of organisation A stops its own replacement and touches nothing of B.
    await addKey(a)
    const target = await colleague(a, 'viewer')
    await ceremony(a, { seatId: target.seatId })
    const ofB = async () => JSON.stringify([
      (await db.prepare('SELECT * FROM credentials WHERE org_id = ? ORDER BY id').bind(b.orgId).all()).results,
      (await db.prepare('SELECT * FROM seats WHERE org_id = ? ORDER BY id').bind(b.orgId).all()).results,
      await count('audit_log', b.orgId),
    ])
    const before = await ofB()
    expect((await stop(target.key)).status).toBe(200)
    expect(await ofB()).toBe(before)
    expect((await call('GET', '/api/me', { cookie: b.cookie })).status).toBe(200)
  },
  'POST /api/members/:id/freeze': async (a, b) => {
    await addKey(a)
    expect((await act(a, b.seatId, 'freeze')).status).toBe(404)
    expect(await row('SELECT state FROM seats WHERE id = ?', b.seatId)).toEqual({ state: 'active' })
    expect((await call('GET', '/api/me', { cookie: b.cookie })).status).toBe(200)
  },
  'POST /api/members/:id/unfreeze': (a, b) => crossRequest(a, b, 'unfreeze'),
  'POST /api/members/:id/role': (a, b) => crossRequest(a, b, 'role'),
  'POST /api/members/:id/remove': (a, b) => crossRequest(a, b, 'remove'),
  'POST /api/policy': async (a, b) => {
    // The organisation is the session's: a body that names another one changes nothing there.
    await addKey(a)
    const asked = await post('/api/policy', a, { syncedKeys: true, orgId: b.orgId, id: b.orgId })
    expect(asked.status).toBe(200)
    expect(await row('SELECT org_id, subject_id FROM approvals WHERE id = ?', asked.body.id)).toEqual({ org_id: a.orgId, subject_id: a.orgId })
    expect(await count('approvals', b.orgId)).toBe(0)
  },
  'POST /api/approvals/:id/approve': (a, b) => crossDecide(a, b, 'approve'),
  'POST /api/approvals/:id/reject': (a, b) => crossDecide(a, b, 'reject'),
  'POST /api/approvals/:id/cancel': (a, b) => crossDecide(a, b, 'cancel'),
  'GET /api/audit': async (a, b) => {
    const page = await call('GET', '/api/audit', { cookie: a.cookie })
    expect(page.body.rows).toHaveLength(await count('audit_log', a.orgId))
    expect(page.body.chain).toMatchObject({ ok: true, rows: await count('audit_log', a.orgId) })
    expect(JSON.stringify(page.body)).not.toContain(b.name)
    expect(JSON.stringify(page.body)).toContain(a.name)
  },
  'POST /api/audit/export': async (a, b) => {
    const rows = await count('audit_log', b.orgId)
    const out = await post('/api/audit/export', a)
    // The heading line, every row of A, and the row of this export.
    expect(out.body.csv.trim().split('\r\n')).toHaveLength((await count('audit_log', a.orgId)) + 1)
    expect(out.body.csv).not.toContain(b.name)
    expect(out.body.csv).toContain(a.name)
    expect(await count('audit_log', b.orgId)).toBe(rows)
  },
}

describe('e. an organisation never sees another', () => {
  it('every route has an isolation case', () => {
    expect(Object.keys(isolation).sort()).toEqual(routes.map((route) => `${route.method} ${route.path}`).sort())
  })
  for (const [route, run] of Object.entries(isolation)) {
    it(route, async () => run(await member('Alder Asset Management'), await member('Birchfield Capital')))
  }
  it('SQL lives in the data module only: elsewhere the database handle is passed on, never used', () => {
    for (const source of [routerSource, passkeySource]) expect(source).not.toMatch(/\.prepare\(|\.batch\(|\bDB\.\w/)
  })
  it('inside an organisation, a Viewer sees only its own seat and cannot revoke a colleague', async () => {
    const owner = await member()
    const seat = await invite(owner.orgId, owner.seatId, 'viewer')
    const key = await softwareAuthenticator(SITE)
    await enrol(seat.ticket, key)
    await data.devActivatePending(db, 'local', now)
    const viewer = await signIn(key)
    const view = await call('GET', '/api/org', { cookie: viewer.cookie })
    expect(view.body.members.map((m: { id: string }) => m.id)).toEqual([seat.seatId])
    expect(view.body.sessions).toHaveLength(1)
    expect(view.body.passkeys).toHaveLength(1)
    expect((await call('POST', `/api/sessions/${owner.sessionId}/revoke`, { cookie: viewer.cookie })).status).toBe(404)
    expect((await call('GET', '/api/me', { cookie: owner.cookie })).status).toBe(200)
    // The Owner sees both seats and may end the Viewer's session.
    const all = await call('GET', '/api/org', { cookie: owner.cookie })
    expect(all.body.members).toHaveLength(2)
    expect((await call('POST', `/api/sessions/${view.body.currentSessionId}/revoke`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: viewer.cookie })).status).toBe(401)
  })
})

describe('f. audit log', () => {
  const actions = async (orgId: string) =>
    (await db.prepare('SELECT action FROM audit_log WHERE org_id = ? ORDER BY seq').bind(orgId).all<{ action: string }>()).results.map((row) => row.action)

  it('each state change writes one row, reads and refusals write none, and the chain verifies', async () => {
    const m = await member()
    const done = ['organisation.seed', 'credential.store', 'credential.activate.dev', 'session.create']
    expect(await actions(m.orgId)).toEqual(done)
    await call('GET', '/api/me', { cookie: m.cookie })
    await call('GET', '/api/org', { cookie: m.cookie })
    await call('POST', '/api/signin/start')
    await signIn(m.key, { as: { origin: 'https://evil.example' } })
    await call('POST', '/api/sessions/0000/revoke', { cookie: m.cookie })
    expect(await actions(m.orgId)).toEqual(done)
    const second = await signIn(m.key)
    const view = await call('GET', '/api/org', { cookie: second.cookie })
    await call('POST', `/api/sessions/${view.body.currentSessionId}/revoke`, { cookie: m.cookie })
    await call('POST', '/api/signout', { cookie: m.cookie })
    expect(await actions(m.orgId)).toEqual([...done, 'session.create', 'session.revoke', 'session.signout'])
    expect(await data.verifyAudit(db, m.orgId)).toMatchObject({ ok: true, rows: 7 })
  })

  it('rows hold ids only', async () => {
    const m = await member('Cedar & Partners')
    const { results } = await db.prepare('SELECT * FROM audit_log WHERE org_id = ?').bind(m.orgId).all<Record<string, unknown>>()
    expect(results).toHaveLength(4)
    for (const row of results) {
      for (const value of Object.values(row)) if (typeof value === 'string') expect(value).toMatch(/^[A-Za-z0-9_.-]+$/)
    }
  })

  // Every state change, with the table its batch writes besides audit_log. `prepare` runs before each
  // of the three phases, outside the blocking trigger, and hands its result to `run`.
  type Full = Awaited<ReturnType<typeof owner>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changes: Record<string, { blocks: string; prepare?: (m: Full) => Promise<any>; run: (m: Full, prepared: any) => Promise<unknown> }> = {
    'organisation.seed': { blocks: 'INSERT ON seats', run: () => organisation().catch(() => 'refused') },
    'credential.store': {
      blocks: 'INSERT ON credentials',
      prepare: (m) => invite(m.orgId, m.seatId, 'viewer'),
      run: async (_, seat) => enrol(seat.ticket, await softwareAuthenticator(SITE)),
    },
    'credential.activate.dev': { blocks: 'UPDATE ON credentials', run: () => data.devActivatePending(db, 'local', now).catch(() => 'refused') },
    'session.create': { blocks: 'INSERT ON sessions', run: (m) => signIn(m.key) },
    'session.revoke': { blocks: 'UPDATE ON sessions', run: (m) => call('POST', `/api/sessions/${m.sessionId}/revoke`, { cookie: m.cookie }) },
    'session.signout': { blocks: 'UPDATE ON sessions', run: (m) => call('POST', '/api/signout', { cookie: m.cookie }) },
    'session.stepup': { blocks: 'UPDATE ON sessions', run: (m) => stepUp(m, m.key) },
    'credential.add': { blocks: 'INSERT ON credentials', run: (m) => addKey(m) },
    'credential.revoke': { blocks: 'UPDATE ON credentials', prepare: async (m) => (await addKey(m)).key, run: (m, key) => post(`/api/passkeys/${key.id}/revoke`, m) },
    'ticket.issue': { blocks: 'INSERT ON enrolment_tickets', run: (m) => issue(m, { displayName: 'Ada Viewer', role: 'viewer' }) },
    'ticket.attempt': { blocks: 'UPDATE ON enrolment_tickets', prepare: (m) => stored(m, 'viewer'), run: (m, t) => confirm(m, t.id, WRONG, m.key) },
    'credential.activate': { blocks: 'UPDATE ON credentials', prepare: (m) => stored(m, 'viewer'), run: (m, t) => confirm(m, t.id, t.words, m.key) },
    // An Admin ticket in an organisation with one key-role member: the issuer's words start the 72 hour wait.
    'ticket.confirm': { blocks: 'INSERT ON approvals', prepare: (m) => stored(m, 'admin'), run: (m, t) => confirm(m, t.id, t.words, m.key) },
    'ticket.cancel': { blocks: 'UPDATE ON enrolment_tickets', prepare: (m) => stored(m, 'viewer'), run: (m, t) => post(`/api/tickets/${t.id}/cancel`, m) },
    'credential.stop': {
      blocks: 'UPDATE ON seats',
      prepare: async (m) => {
        const target = await colleague(m, 'viewer')
        await ceremony(m, { seatId: target.seatId })
        return target
      },
      run: (_, target) => stop(target.key),
    },
    'seat.freeze': { blocks: 'UPDATE ON seats', prepare: (m) => colleague(m, 'viewer'), run: (m, v) => act(m, v.seatId, 'freeze') },
    'approval.request': { blocks: 'INSERT ON approvals', prepare: (m) => colleague(m, 'viewer'), run: (m, v) => act(m, v.seatId, 'role', { role: 'trader' }) },
    'seat.role': { blocks: 'UPDATE ON seats', prepare: (m) => asked(m), run: (_, p) => decide(p.approver, p.id, 'approve') },
    'approval.reject': { blocks: 'UPDATE ON approvals', prepare: (m) => asked(m), run: (_, p) => decide(p.approver, p.id, 'reject') },
    'approval.cancel': { blocks: 'UPDATE ON approvals', prepare: (m) => asked(m), run: (m, p) => decide(m, p.id, 'cancel') },
    // An invited seat that never enrolled: one person removes it.
    'seat.remove': { blocks: 'UPDATE ON seats', prepare: (m) => issue(m, { displayName: 'Never Came', role: 'viewer' }), run: (m, t) => act(m, t.body.seatId, 'remove') },
  }
  // A role change that waits for its second person, and that person.
  async function asked(m: Full) {
    const viewer = await colleague(m, 'viewer')
    return { approver: await colleague(m, 'approver'), id: (await act(m, viewer.seatId, 'role', { role: 'trader' })).body.id as string }
  }
  async function stored(m: Full, role: string) {
    const ticket = await issue(m, { displayName: `New ${role}`, role })
    return { id: ticket.body.ticketId as string, words: (await enrolLink(ticket.body.link)).words }
  }
  for (const [action, change] of Object.entries(changes)) {
    it(`${action}: the change and its audit row succeed or fail together`, async () => {
      const m = await owner()
      // A viewer with a stored, pending passkey gives the activation command something to do.
      await enrol((await invite(m.orgId, m.seatId, 'viewer')).ticket, await softwareAuthenticator(SITE))
      const before = await snapshot()
      // The audit row cannot be written: the change must not happen.
      let prepared = await change.prepare?.(m)
      const stateBefore = await snapshot()
      await withTrigger('INSERT ON audit_log', async () => void (await change.run(m, prepared)))
      expect(await snapshot()).toBe(stateBefore)
      // The change cannot be written: no audit row may appear.
      prepared = await change.prepare?.(m)
      const rowsBefore = async () => (await db.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>())!.n
      let rows = await rowsBefore()
      await withTrigger(change.blocks, async () => void (await change.run(m, prepared)))
      expect(await rowsBefore()).toBe(rows)
      // With nothing blocked, the same call writes exactly one audit row carrying this action.
      prepared = await change.prepare?.(m)
      rows = await rowsBefore()
      await change.run(m, prepared)
      const last = await db.prepare('SELECT action FROM audit_log ORDER BY at DESC, rowid DESC LIMIT 1').first<{ action: string }>()
      expect(last!.action).toBe(action)
      expect(await rowsBefore()).toBe(rows + 1)
      expect(before).not.toBe(await snapshot())
    })
  }
  it('the list above covers every state-changing route', () => {
    expect(routes.filter((route) => route.method === 'POST').map((route) => route.path).sort()).toEqual([
      // /api/audit/export writes its audit row and nothing else: section w proves that no file leaves without the row.
      '/api/approvals/:id/approve', '/api/approvals/:id/cancel', '/api/approvals/:id/reject', '/api/audit/export',
      '/api/enrol/finish', '/api/enrol/start', '/api/members/:id/freeze', '/api/members/:id/remove', '/api/members/:id/role', '/api/members/:id/unfreeze',
      '/api/passkeys/:id/revoke', '/api/passkeys/finish', '/api/passkeys/start', '/api/policy', '/api/sessions/:id/revoke',
      '/api/signin/finish', '/api/signin/start', '/api/signout', '/api/stepup/finish', '/api/stepup/start', '/api/stop/finish', '/api/stop/start',
      '/api/tickets', '/api/tickets/:id/cancel', '/api/tickets/:id/confirm', '/api/tickets/:id/confirm/start',
    ])
  })

  it('two writes of one organisation that collide on the audit sequence: the later one is retried, once', async () => {
    const m = await member()
    const finish = async (collisions: number) => {
      const start = await call('POST', '/api/signin/start')
      const response = await m.key.authenticate(start.body.options)
      return call('POST', '/api/signin/finish', { body: { response }, env: racing(async () => expect((await signIn(m.key)).status).toBe(200), collisions) })
    }
    expect((await finish(1)).status).toBe(200)
    expect(await count('sessions', m.orgId)).toBe(3) // the member's own, the competing one, the retried one
    expect((await finish(2)).status).toBe(401) // one retry, not a loop: the caller is told to try again
    expect(await count('sessions', m.orgId)).toBe(5)
    expect(await data.verifyAudit(db, m.orgId)).toMatchObject({ ok: true, rows: 8 })
  })

  it('a changed row, a removed row and a forged tail are detected', async () => {
    const m = await member()
    expect(await data.verifyAudit(db, m.orgId)).toMatchObject({ ok: true, rows: 4 })
    await expect(db.prepare(`UPDATE audit_log SET action = 'x' WHERE org_id = ?`).bind(m.orgId).run()).rejects.toThrow(/append-only/)
    await expect(db.prepare('DELETE FROM audit_log WHERE org_id = ?').bind(m.orgId).run()).rejects.toThrow(/append-only/)
    // Someone with SQL access drops the triggers. The chain still tells.
    await db.batch([db.prepare('DROP TRIGGER audit_log_no_update'), db.prepare('DROP TRIGGER audit_log_no_delete')])
    await db.prepare(`UPDATE audit_log SET subject_id = 'another-credential' WHERE org_id = ? AND seq = 2`).bind(m.orgId).run()
    expect(await data.verifyAudit(db, m.orgId)).toEqual({ ok: false, seq: 2 })
    // A forger who also recomputes the hash of the row they changed is caught at the next row's link.
    // The recipe is written out here on purpose: a checker that imports what it checks proves nothing.
    const forged = await member()
    const row = (await db.prepare('SELECT * FROM audit_log WHERE org_id = ? AND seq = 2').bind(forged.orgId).first<Record<string, unknown>>())!
    const fields = [row.org_id, row.seq, row.at, row.actor_kind, 'someone-else', row.session_id, row.action, row.subject_id, row.detail, row.country, row.asn, row.prev_hash]
    await db.prepare(`UPDATE audit_log SET actor_id = 'someone-else', hash = ? WHERE org_id = ? AND seq = 2`).bind(await data.sha256Hex(JSON.stringify(fields)), forged.orgId).run()
    expect(await data.verifyAudit(db, forged.orgId)).toEqual({ ok: false, seq: 3 })
    const other = await member()
    await db.prepare('DELETE FROM audit_log WHERE org_id = ? AND seq = 3').bind(other.orgId).run()
    expect(await data.verifyAudit(db, other.orgId)).toEqual({ ok: false, seq: 4 }) // the row after the gap no longer links
    const third = await member()
    await db.prepare(`INSERT INTO audit_log (org_id, seq, at, actor_kind, action, prev_hash, hash) VALUES (?, 5, ?, 'system', 'forged', ?, ?)`)
      .bind(third.orgId, now, '0'.repeat(64), 'f'.repeat(64)).run()
    expect(await data.verifyAudit(db, third.orgId)).toEqual({ ok: false, seq: 5 })
    await db.batch([
      db.prepare(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`),
      db.prepare(`CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`),
    ])
  })
})

describe('g. security headers', () => {
  const API = {
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=63072000',
  }
  it('every API response carries them: success, refusal, unknown route and failure', async () => {
    const responses = [
      await call('POST', '/api/signin/start'),
      await call('GET', '/api/me'),
      await call('GET', '/api/me', { headers: { 'sec-fetch-site': 'cross-site' } }),
      await call('GET', '/api/nothing-here'),
      await call('POST', '/api/signin/start', { env: { ...testEnv, ENVIRONMENT: 'somewhere-else' } }),
      await call('POST', '/api/signin/start', { env: { ...testEnv, CHALLENGE_KEY: 'short' } }),
    ]
    expect(responses.map((response) => response.status)).toEqual([200, 401, 403, 404, 500, 500])
    for (const response of responses) {
      for (const [name, value] of Object.entries(API)) expect(response.headers.get(name)).toBe(value)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
    }
    expect(responses[4].body).toEqual({ error: 'internal' })
  })
  it('pages carry them: public/_headers holds the strict policy for every path', () => {
    const [, block] = pageHeaders.split(/^\/\*\n/m)
    const sent = Object.fromEntries(block.split(/\n(?=\S)/)[0].split('\n').filter(Boolean).map((line) => {
      const [name, ...value] = line.trim().split(': ')
      return [name.toLowerCase(), value.join(': ')]
    }))
    expect(sent['content-security-policy'].split('; ').sort()).toEqual([
      "base-uri 'none'", "connect-src 'self'", "default-src 'none'", "font-src 'self'", "form-action 'self'", "frame-ancestors 'none'",
      "img-src 'self'", "require-trusted-types-for 'script'", "script-src 'self'", "style-src 'self'", "trusted-types 'none'",
    ])
    for (const name of ['x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'cross-origin-opener-policy', 'x-frame-options', 'strict-transport-security']) {
      expect(sent[name]).toBe(API[name as keyof typeof API])
    }
    expect(pageHeaders).not.toMatch(/access-control|unsafe-inline|unsafe-eval/i)
  })
})

describe('h. sign-in start', () => {
  it('the snapshot below covers every table', async () => {
    const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name`).all<{ name: string }>()
    expect(results.map((row) => row.name)).toEqual(TABLES)
  })
  it('writes no row, however often it is called, signed in or not', async () => {
    const m = await member()
    const before = await snapshot()
    for (let i = 0; i < 25; i++) expect((await call('POST', '/api/signin/start', i % 2 ? { cookie: m.cookie } : {})).status).toBe(200)
    expect(await snapshot()).toBe(before)
  })
  it('a failed sign-in looks the same whatever the reason, and writes no row', async () => {
    const m = await member()
    const pendingOrg = await organisation()
    const pending = await softwareAuthenticator(SITE)
    await enrol(pendingOrg.ticket, pending)
    const before = await snapshot()
    const failures = [
      await signIn(await softwareAuthenticator(SITE)), // no such passkey
      await signIn(pending), // known, not active
      await signIn(m.key, { as: { origin: 'https://evil.example' } }), // known and active, wrong site
      await call('POST', '/api/signin/finish', { body: {} }), // no assertion at all
    ]
    for (const failure of failures) {
      expect(failure.status).toBe(401)
      expect(failure.body).toEqual({ error: 'sign_in_failed' })
      expect(failure.headers.get('set-cookie')).toBeNull()
    }
    expect(await snapshot()).toBe(before)
  })
})

describe('i. the schema refuses what the code must never do', () => {
  it('a row cannot point at a seat of another organisation', async () => {
    const a = await member()
    const b = await member()
    await expect(
      db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, device_bound, label, state, created_at) VALUES (?, ?, ?, 'key', 1, 'label', 'pending', 0)`)
        .bind(data.randomId(), a.orgId, b.seatId).run(),
    ).rejects.toThrow(/FOREIGN KEY/)
    await expect(
      db.prepare(`INSERT INTO sessions (id, token_hash, challenge_hash, org_id, seat_id, credential_id, created_at, last_seen_at, step_up_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`)
        .bind(data.randomId(), data.randomId(), data.randomId(), a.orgId, a.seatId, b.key.id).run(),
    ).rejects.toThrow(/FOREIGN KEY/)
  })
  it('the maker of a change is never its checker', async () => {
    const m = await member()
    const approval = (checker: string | null) =>
      db.prepare(`INSERT INTO approvals (id, org_id, action, subject_id, payload_hash, requester_seat_id, checker_seat_id, state, expires_at, created_at) VALUES (?, ?, 'wallet.link', 'subject', 'hash', ?, ?, 'pending', 1, 0)`)
        .bind(data.randomId(), m.orgId, m.seatId, checker).run()
    await approval(null)
    await expect(approval(m.seatId)).rejects.toThrow(/CHECK/)
  })
  it('an organisation has one recovery anchor in force', async () => {
    const m = await member()
    const wallet = (digit: string, anchor: string | null) =>
      db.prepare(`INSERT INTO wallets (id, org_id, chain_id, address, kind, label, state, proof_nonce, proof_digest, proof_signature, proof_checked_at, linked_at, anchor)
                  VALUES (?, ?, 1, ?, 'safe', 'Treasury', 'linked', ?, 'digest', '0x', 0, 0, ?)`)
        .bind(data.randomId(), m.orgId, `0x${digit.repeat(40)}`, data.randomId(), anchor).run()
    await wallet('1', 'current')
    await wallet('2', null)
    await wallet('3', 'next')
    await expect(wallet('4', 'current')).rejects.toThrow(/UNIQUE/)
  })
  it('the audit sequence of an organisation cannot fork', async () => {
    const m = await member()
    await expect(
      db.prepare(`INSERT INTO audit_log (org_id, seq, at, actor_kind, action, prev_hash, hash) VALUES (?, 4, 0, 'system', 'second-writer', 'p', 'h')`).bind(m.orgId).run(),
    ).rejects.toThrow(/UNIQUE/)
  })
})

describe('j. the three-word phrase', () => {
  const input = { site: 'localhost', orgId: 'a'.repeat(32), seatId: 'b'.repeat(32), role: 'viewer', purpose: 'invitation', credentialHash: new Uint8Array(32).fill(7), nonce: 'c'.repeat(32) }

  it('the word list is the EFF short list 2.0: 1,296 words, no two with the same first three letters', async () => {
    expect(WORDS).toHaveLength(1296)
    expect(new Set(WORDS.map((word) => word.slice(0, 3))).size).toBe(1296)
    expect(WORDS.every((word) => /^[a-z-]{3,10}$/.test(word))).toBe(true)
    // SHA-256 of the words joined by line feeds, computed from the downloaded file with another tool.
    expect(await data.sha256Hex(WORDS.join('\n'))).toBe('7869e4a279a3f019df21fa2b28985656a2ee936dadad9aedc87759dab54aef4f')
  })
  it('is derived as recovery.md section 2 specifies', async () => {
    // The recipe is written out here on purpose: a checker that imports what it checks proves nothing.
    const utf8 = (value: string) => new TextEncoder().encode(value)
    const field = (bytes: Uint8Array) => [0, 0, bytes.length >> 8, bytes.length & 255, ...bytes]
    const nonce = Uint8Array.from(input.nonce.match(/../g)!, (pair) => parseInt(pair, 16))
    const bytes = Uint8Array.from([utf8('ophis-enrol-v1'), utf8(input.site), utf8(input.orgId), utf8(input.seatId), utf8(input.role), utf8(input.purpose), input.credentialHash, nonce].flatMap(field))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const n = new DataView(digest.buffer).getBigUint64(0) % 1296n ** 3n
    const expected = [n / 1296n ** 2n, (n / 1296n) % 1296n, n % 1296n].map((index) => WORDS[Number(index)])
    expect(await phraseFor(input)).toEqual(expected)
    // The credential hash covers the credential id and the public key, each with its length.
    const id = Uint8Array.from([1, 2, 3])
    const key = Uint8Array.from([4, 5])
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from([id, key].flatMap(field))))
    expect([...(await credentialHash('AQID', 'BAU'))]).toEqual([...hash])
    expect(fromBase64Url('AQID')).toEqual(id)
  })
  it('is the same for the same input and changes with every input', async () => {
    const base = (await phraseFor(input)).join(' ')
    expect((await phraseFor({ ...input })).join(' ')).toBe(base)
    const other = { site: 'business.example', orgId: 'd'.repeat(32), seatId: 'e'.repeat(32), role: 'trader', purpose: 're_enrolment', credentialHash: new Uint8Array(32).fill(8), nonce: 'f'.repeat(32) }
    for (const name of Object.keys(other) as (keyof typeof other)[]) {
      expect((await phraseFor({ ...input, [name]: other[name] })).join(' '), name).not.toBe(base)
    }
    // Length prefixes: moving a character from one field to the next gives another phrase.
    expect((await phraseFor({ ...input, role: 'viewe', purpose: 'rinvitation' })).join(' ')).not.toBe(base)
  })
  it('a challenge made for one purpose does not pass for another, with the same binding', async () => {
    const key = testEnv.CHALLENGE_KEY
    for (const [made, used] of [['signin', 'stepup'], ['stepup', 'signin'], ['signin', 'stop'], ['confirm', 'stepup'], ['enrol', 'add']] as const) {
      const challenge = await newChallenge(key, made, 'same', now)
      expect(await challengeIsOurs(key, made, 'same', challenge, now)).toBe(true)
      expect(await challengeIsOurs(key, used, 'same', challenge, now), `${made} as ${used}`).toBe(false)
      expect(await challengeIsOurs(key, made, 'other', challenge, now)).toBe(false)
    }
  })
})

// ---- milestone 2: step-up, own passkeys, tickets, the three words, the stop right, quarantine, alerts ----

describe('k. step-up: a fresh passkey check before a sensitive action', () => {
  const viewer = (name: string) => ({ displayName: name, role: 'viewer' })

  it('a sensitive call more than 5 minutes after the last passkey check answers "step-up required"', async () => {
    const o = await owner()
    now += 5 * MIN
    expect((await issue(o, viewer('Ada Viewer'))).status).toBe(200)
    now += 1
    const late = await issue(o, viewer('Bea Viewer'))
    expect(late.status).toBe(403)
    expect(late.body).toEqual({ error: 'step_up_required' })
    expect((await post('/api/passkeys/start', o)).body).toEqual({ error: 'step_up_required' })
    expect(await count('seats', o.orgId)).toBe(2)
    expect((await stepUp(o, o.key)).status).toBe(200)
    expect((await issue(o, viewer('Bea Viewer'))).status).toBe(200)
    // The window runs from the passkey check, and reading never needs one.
    now += 5 * MIN + 1
    expect((await issue(o, viewer('Cal Viewer'))).body).toEqual({ error: 'step_up_required' })
    expect((await call('GET', '/api/org', { cookie: o.cookie })).status).toBe(200)
  })

  it('the routes that need a fresh check, and the routes that need two passkeys, are these', () => {
    const paths = (flag: 'fresh' | 'twoKeys') => routes.filter((route) => route[flag]).map((route) => route.path).sort()
    const m3 = ['/api/approvals/:id/approve', '/api/approvals/:id/reject', '/api/members/:id/freeze', '/api/members/:id/remove', '/api/members/:id/role', '/api/members/:id/unfreeze']
    expect(paths('fresh')).toEqual([...m3.slice(0, 2), '/api/audit/export', ...m3.slice(2), '/api/passkeys/:id/revoke', '/api/passkeys/finish', '/api/passkeys/start', '/api/policy', '/api/tickets', '/api/tickets/:id/cancel'])
    // Confirming carries its own passkey check, made for the ticket.
    expect(paths('twoKeys')).toEqual([...m3, '/api/passkeys/:id/revoke', '/api/policy', '/api/tickets', '/api/tickets/:id/cancel', '/api/tickets/:id/confirm', '/api/tickets/:id/confirm/start'])
    expect(routes.filter((route) => (route.fresh || route.twoKeys || route.settled || route.second) && route.roles === 'public')).toEqual([])
  })

  it('step-up gives the session a new token: the old one is dead at once', async () => {
    const m = await member()
    const old = m.cookie
    now += 10 * MIN
    const done = await stepUp(m, m.key)
    expect(done.status).toBe(200)
    // The 12 hours still run from the sign-in: 43200 s less the 600 s already spent.
    expect(done.headers.get('set-cookie')).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=42600$/)
    expect(m.cookie).not.toBe(old)
    expect((await call('GET', '/api/me', { cookie: old })).status).toBe(401)
    const me = await call('GET', '/api/me', { cookie: m.cookie })
    expect(me.body.session).toEqual({ id: m.sessionId, endsAt: START + 12 * HOUR, stepUpUntil: now + 5 * MIN })
    expect(await row('SELECT token_hash, step_up_at, created_at FROM sessions WHERE id = ?', m.sessionId))
      .toEqual({ token_hash: await data.sha256Hex(m.cookie.split('=')[1]), step_up_at: now, created_at: START })
  })

  it('a step-up answers only a step-up challenge of this session, once, from an active passkey of the seat', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const quiet = (await addKey(o, { counts: false })).key // its counter stays 0: only the challenge can stop a replay
    const other = await again({ key: o.key, cookie: '' }) // a second session of the same seat
    const before = o.cookie
    const refused = async (response: unknown) => {
      const finish = await post('/api/stepup/finish', o, { response })
      expect(finish.status).toBe(403)
      expect(finish.body).toEqual({ error: 'passkey_rejected' })
      expect(finish.headers.get('set-cookie')).toBeNull()
    }
    // A sign-in challenge does not pass as a step-up challenge, and the reverse.
    await refused(await o.key.authenticate((await call('POST', '/api/signin/start')).body.options))
    const start = await post('/api/stepup/start', o)
    expect((await call('POST', '/api/signin/finish', { body: { response: await o.key.authenticate(start.body.options) } })).status).toBe(401)
    // A challenge issued to another session of the same seat.
    await refused(await o.key.authenticate((await post('/api/stepup/start', other)).body.options))
    // Another origin, no user verification, a passkey of another seat, a passkey that is not active, nothing at all.
    await refused(await o.key.authenticate(start.body.options, { as: { origin: 'https://evil.example' } }))
    await refused(await o.key.authenticate(start.body.options, { userVerified: false }))
    await refused(await (await member()).key.authenticate(start.body.options))
    // A colleague's passkey, even when it names this seat: the user handle is not part of what a passkey signs.
    await refused(await admin.key.authenticate(start.body.options))
    await refused(await admin.key.authenticate(start.body.options, { userHandle: userHandle(o.seatId) }))
    await db.prepare(`UPDATE credentials SET state = 'suspended' WHERE id = ?`).bind(o.key2.id).run()
    await refused(await o.key2.authenticate(start.body.options))
    await db.prepare(`UPDATE credentials SET state = 'active' WHERE id = ?`).bind(o.key2.id).run()
    await refused(undefined)
    expect((await call('GET', '/api/me', { cookie: before })).status).toBe(200)
    // It works once: the token it was bound to is gone.
    const response = await quiet.authenticate(start.body.options)
    const first = await post('/api/stepup/finish', o, { response })
    expect(first.status).toBe(200)
    o.cookie = cookieOf(first)
    await refused(response)
    // And for 5 minutes.
    const stale = await quiet.authenticate((await post('/api/stepup/start', o)).body.options)
    now += 5 * MIN + 1
    await refused(stale)
  })

  it('two requests with one step-up answer at the same instant: one passes', async () => {
    const o = await owner()
    const quiet = (await addKey(o, { counts: false })).key
    const body = { response: await quiet.authenticate((await post('/api/stepup/start', o)).body.options) }
    let first = { status: 0 }
    const second = await call('POST', '/api/stepup/finish', { cookie: o.cookie, body, env: racing(async () => (first = await post('/api/stepup/finish', o, body))) })
    expect([first.status, second.status]).toEqual([200, 403])
    expect(second.headers.get('set-cookie')).toBeNull()
  })

  it('an Owner seat with fewer than two device-bound keys can sign in and add its second key, and nothing else that is sensitive', async () => {
    const m = await member()
    expect((await call('GET', '/api/me', { cookie: m.cookie })).body.seat.keys).toBe(1)
    const calls: [string, unknown?][] = [
      ['/api/tickets', viewer('Ada Viewer')], ['/api/tickets/0000/confirm/start'], ['/api/tickets/0000/confirm', { words: WRONG }],
      ['/api/tickets/0000/cancel'], [`/api/passkeys/${m.key.id}/revoke`],
    ]
    const refusedAll = async () => {
      for (const [path, body] of calls) {
        const refused = await post(path, m, body)
        expect(refused.status, path).toBe(403)
        expect(refused.body).toEqual({ error: 'second_key_required' })
      }
    }
    await refusedAll()
    expect(await count('seats', m.orgId)).toBe(1)
    expect(await credentialState(m.key)).toBe('active')
    // Reading, a passkey check and the second key stay open.
    expect((await call('GET', '/api/org', { cookie: m.cookie })).status).toBe(200)
    expect((await stepUp(m, m.key)).status).toBe(200)
    const second = await addKey(m)
    expect(second.status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: m.cookie })).body.seat.keys).toBe(2)
    expect((await issue(m, viewer('Ada Viewer'))).status).toBe(200)
    // Two keys, but only one bound to its device: not enough for an Owner.
    await db.prepare('UPDATE credentials SET device_bound = 0 WHERE id = ?').bind(second.key.id).run()
    await refusedAll()
    // A key that is no longer active does not count either.
    await db.prepare(`UPDATE credentials SET device_bound = 1, state = 'revoked' WHERE id = ?`).bind(second.key.id).run()
    await refusedAll()
  })

  it('every seat needs two active passkeys before a sensitive action (recovery.md section 1)', async () => {
    const o = await owner()
    const seat = await invite(o.orgId, o.seatId, 'admin')
    const key = await softwareAuthenticator(SITE)
    await enrol(seat.ticket, key)
    await data.devActivatePending(db, 'local', now)
    const admin = await again({ key, cookie: '' })
    expect((await issue(admin, viewer('Ada Viewer'))).body).toEqual({ error: 'second_key_required' })
    expect((await addKey(admin)).status).toBe(200)
    expect((await issue(admin, viewer('Ada Viewer'))).status).toBe(200)
  })
})

describe('l. a member adds and revokes passkeys on their own seat', () => {
  it('a new passkey needs a fresh check from an existing one, is active at once, and ends the other sessions of the seat', async () => {
    const m = await member()
    const other = await again({ key: m.key, cookie: '' })
    now += 5 * MIN + 1
    expect((await addKey(m)).body).toEqual({ error: 'step_up_required' })
    expect(await count('credentials', m.orgId)).toBe(1)
    expect((await stepUp(m, m.key)).status).toBe(200)
    const added = await addKey(m)
    expect(added.status).toBe(200)
    expect(await row('SELECT state, seat_id, org_id, ticket_id, device_bound, label FROM credentials WHERE id = ?', added.key.id))
      .toEqual({ state: 'active', seat_id: m.seatId, org_id: m.orgId, ticket_id: null, device_bound: 1, label: `Office key ${labels}` })
    expect((await call('GET', '/api/me', { cookie: other.cookie })).status).toBe(401)
    expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    expect((await signIn(added.key)).status).toBe(200)
  })

  it('the new passkey answers a challenge made in this session to add a passkey, follows the key rule of the role, and has a plain label', async () => {
    const m = await member()
    expect((await addKey(m, { backupEligible: true })).body).toEqual({ error: 'device_bound_required' })
    expect((await addKey(m, {}, { as: { origin: 'https://evil.example' } })).body).toEqual({ error: 'passkey_rejected' })
    expect((await addKey(m, {}, { userVerified: false })).body).toEqual({ error: 'passkey_rejected' })
    // A challenge made for an enrolment ticket, and one made in another session, add nothing here.
    const seat = await invite(m.orgId, m.seatId, 'viewer')
    const key = await softwareAuthenticator(SITE)
    const finish = (holder: Holder, options: Parameters<Key['register']>[0], label = 'Key') => key.register(options).then((response) => post('/api/passkeys/finish', holder, { label, response }))
    const forTicket = await call('POST', '/api/enrol/start', { body: { ticket: seat.ticket } })
    expect((await finish(m, forTicket.body.options)).body).toEqual({ error: 'passkey_rejected' })
    const stranger = await member()
    expect((await finish(m, (await post('/api/passkeys/start', stranger)).body.options)).body).toEqual({ error: 'passkey_rejected' })
    // The reverse: a challenge made to add a passkey stores nothing on a ticket.
    const mine = await post('/api/passkeys/start', m)
    expect((await call('POST', '/api/enrol/finish', { body: { ticket: seat.ticket, label: 'Key', response: await key.register(mine.body.options) } })).status).toBe(400)
    for (const label of ['', '<b>key</b>', 'x'.repeat(41), 7]) expect((await finish(m, mine.body.options, label as string)).body).toEqual({ error: 'label_invalid' })
    expect(await count('credentials', m.orgId)).toBe(1)
    // The options name the seat and list its passkeys, so a security key that already holds one refuses.
    expect(mine.body.deviceBound).toBe(true)
    expect(mine.body.options.user.id).toBe(userHandle(m.seatId))
    expect(mine.body.options.excludeCredentials).toEqual([{ type: 'public-key', id: m.key.id }])
    // The same registration cannot be stored twice.
    const response = await key.register(mine.body.options)
    expect((await post('/api/passkeys/finish', m, { label: 'Key', response })).status).toBe(200)
    expect((await post('/api/passkeys/finish', m, { label: 'Key', response })).status).toBe(409)
    // A Viewer may add a synced passkey.
    const viewer = await colleague(m, 'viewer')
    expect((await addKey(viewer, { backupEligible: true })).status).toBe(200)
  })

  it('a seat holds 10 passkeys at most', async () => {
    const m = await member()
    for (let n = 2; n <= 10; n++) expect((await addKey(m)).status, `passkey ${n}`).toBe(200)
    expect((await addKey(m)).status).toBe(409)
    expect(await count('credentials', m.orgId)).toBe(10)
  })

  it('revoking: the own passkey; a colleague\'s by an Owner or Admin, never above the own role; never a replaced passkey; never the last one', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    const revoke = (m: Holder, key: Key) => post(`/api/passkeys/${key.id}/revoke`, m)
    // A Viewer sees only its own seat. An Admin does not touch an Owner's passkey.
    expect((await revoke(viewer, admin.key2)).status).toBe(404)
    expect((await revoke(admin, o.key2)).body).toEqual({ error: 'forbidden' })
    expect(await credentialState(admin.key2)).toBe('active')
    expect(await credentialState(o.key2)).toBe('active')
    // An Owner revokes an Admin's passkey: it signs in no more.
    expect((await revoke(o, admin.key2)).status).toBe(200)
    expect(await credentialState(admin.key2)).toBe('revoked')
    expect((await signIn(admin.key2)).status).toBe(401)
    expect((await revoke(o, admin.key2)).status).toBe(404)
    // A replaced passkey keeps its stop right: nobody revokes it.
    await db.prepare(`UPDATE credentials SET state = 'suspended', stop_right_until = ? WHERE id = ?`).bind(now + HOUR, viewer.key2.id).run()
    expect((await revoke(o, viewer.key2)).status).toBe(404)
    expect(await credentialState(viewer.key2)).toBe('suspended')
    await db.prepare(`UPDATE credentials SET state = 'active', stop_right_until = NULL WHERE id = ?`).bind(viewer.key2.id).run()
    // The member's own: a fresh check, then gone. With one passkey left the seat is restricted, so the last one stays.
    now += 5 * MIN + 1
    expect((await revoke(viewer, viewer.key2)).body).toEqual({ error: 'step_up_required' })
    await stepUp(viewer, viewer.key)
    expect((await revoke(viewer, viewer.key2)).status).toBe(200)
    expect((await revoke(viewer, viewer.key)).body).toEqual({ error: 'second_key_required' })
    const actor = { orgId: o.orgId, seatId: viewer.seatId, sessionId: 'none', role: 'viewer' as const, quarantineUntil: null, country: null, asn: null }
    expect(await data.revokeCredential(db, actor, viewer.key.id, now)).toBe('last_passkey')
    expect(await credentialState(viewer.key)).toBe('active')
    // Revoking the passkey of the session itself ends that session.
    await stepUp(o, o.key2)
    expect((await revoke(o, o.key)).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: o.cookie })).status).toBe(401)
    expect((await signIn(o.key2)).status).toBe(200)
  })
})

describe('m. enrolment tickets', () => {
  it('only an Owner or Admin issues, never for a role above their own, never for their own seat', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    for (const role of ['trader', 'approver', 'compliance', 'viewer']) {
      const m = await colleague(o, role)
      expect((await issue(m, { displayName: 'New Viewer', role: 'viewer' })).body, role).toEqual({ error: 'forbidden' })
      expect((await issue(m, { seatId: admin.seatId })).body, role).toEqual({ error: 'forbidden' })
    }
    const before = [await count('enrolment_tickets', o.orgId), await count('seats', o.orgId)]
    // An Admin cannot issue for an Owner seat: neither a new Owner nor the re-enrolment of one.
    expect((await issue(admin, { displayName: 'New Owner', role: 'owner' })).body).toEqual({ error: 'forbidden' })
    expect((await issue(admin, { seatId: o.seatId })).body).toEqual({ error: 'forbidden' })
    expect((await issue(admin, { seatId: admin.seatId })).status).toBe(404)
    expect((await issue(o, { seatId: o.seatId })).status).toBe(404)
    for (const bad of [{ displayName: 'X', role: 'operator' }, { displayName: '<b>x</b>', role: 'viewer' }, { displayName: '', role: 'viewer' }, { displayName: 'x'.repeat(61), role: 'viewer' }, { seatId: 'nope' }, {}]) {
      expect((await issue(o, bad as never)).status).toBe(400)
    }
    // A seat that is frozen or removed gets no ticket.
    for (const state of ['frozen', 'removed']) {
      await db.prepare('UPDATE seats SET state = ? WHERE id = ?').bind(state, admin.seatId).run()
      expect((await issue(o, { seatId: admin.seatId })).status, state).toBe(404)
    }
    await db.prepare(`UPDATE seats SET state = 'active' WHERE id = ?`).bind(admin.seatId).run()
    expect([await count('enrolment_tickets', o.orgId), await count('seats', o.orgId)]).toEqual(before)
    for (const role of ['admin', 'approver', 'compliance', 'trader', 'viewer']) expect((await issue(admin, { displayName: `New ${role}`, role })).body.kind).toBe('invitation')
    expect((await issue(o, { displayName: 'Second Owner', role: 'owner' })).status).toBe(200)
    expect((await issue(o, { seatId: admin.seatId })).body).toMatchObject({ kind: 're_enrolment', role: 'admin', seatId: admin.seatId })
  })

  it('the ticket is a 256-bit token in the link fragment, shown once; the database holds only its SHA-256', async () => {
    const o = await owner()
    const ticket = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    expect(ticket.body.link).toMatch(/^http:\/\/localhost:8787\/#\/enrol\/[A-Za-z0-9_-]{43}$/)
    const token = ticket.body.link.split('#/enrol/')[1]
    const stored = (await row<Record<string, string>>('SELECT * FROM enrolment_tickets WHERE id = ?', ticket.body.ticketId))!
    expect(stored).toMatchObject({ token_hash: await data.sha256Hex(token), kind: 'invitation', role: 'viewer', state: 'issued', issuer_seat_id: o.seatId, seat_id: ticket.body.seatId, attempts: 0 })
    expect(stored.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(await snapshot()).not.toContain(token)
    expect(await row('SELECT state, role, display_name FROM seats WHERE id = ?', ticket.body.seatId)).toEqual({ state: 'invited', role: 'viewer', display_name: 'Ada Viewer' })
    const view = JSON.stringify((await call('GET', '/api/org', { cookie: o.cookie })).body)
    expect(view).toContain(ticket.body.ticketId)
    for (const secret of [token, stored.token_hash, stored.nonce]) expect(view).not.toContain(secret)
  })

  it('a Trader or Viewer ticket lives 24 hours, a key-role ticket 10 minutes', async () => {
    const o = await owner()
    const open = (link: string) => call('POST', '/api/enrol/start', { body: { ticket: link.split('#/enrol/')[1] } }).then((start) => start.status)
    const long = [await issue(o, { displayName: 'Ada Viewer', role: 'viewer' }), await issue(o, { displayName: 'Tom Trader', role: 'trader' })]
    const short = [await issue(o, { displayName: 'An Admin', role: 'admin' }), await issue(o, { displayName: 'An Approver', role: 'approver' }), await issue(o, { displayName: 'A Compliance', role: 'compliance' }), await issue(o, { displayName: 'An Owner', role: 'owner' })]
    for (const ticket of long) expect(ticket.body.expiresAt).toBe(START + 24 * HOUR)
    for (const ticket of short) expect(ticket.body.expiresAt).toBe(START + 10 * MIN)
    now = START + 10 * MIN - 1
    for (const ticket of short) expect(await open(ticket.body.link)).toBe(200)
    now = START + 10 * MIN
    for (const ticket of short) expect(await open(ticket.body.link)).toBe(404)
    now = START + 24 * HOUR - 1
    for (const ticket of long) expect(await open(ticket.body.link)).toBe(200)
    now = START + 24 * HOUR
    for (const ticket of long) expect(await open(ticket.body.link)).toBe(404)
  })

  it('three tickets per issuer and seat in 24 hours: a fourth is refused, a first by another issuer is not', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    const trader = await colleague(o, 'trader')
    for (let i = 0; i < 3; i++) expect((await issue(admin, { seatId: viewer.seatId })).status).toBe(200)
    const fourth = await issue(admin, { seatId: viewer.seatId })
    expect(fourth.status).toBe(429)
    expect(fourth.body).toEqual({ error: 'ticket_limit' })
    expect(await count('enrolment_tickets', o.orgId)).toBe(4 + 3) // the seed and three colleagues, then these three
    // The count is per issuer and per seat: one hostile Admin cannot use up a colleague's tickets.
    expect((await issue(o, { seatId: viewer.seatId })).status).toBe(200)
    expect((await issue(admin, { seatId: trader.seatId })).status).toBe(200)
    now += 24 * HOUR
    await again(admin)
    expect((await issue(admin, { seatId: viewer.seatId })).status).toBe(200)
  })

  it('the waiting list: an Owner or Admin sees every open ticket, a key role only those waiting for its words, a Trader or Viewer none', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const approver = await colleague(o, 'approver')
    const viewer = await colleague(o, 'viewer')
    const trader = await colleague(o, 'trader')
    const list = async (m: Holder) => (await call('GET', '/api/org', { cookie: m.cookie })).body.tickets as Record<string, unknown>[]
    const linked = await issue(admin, { displayName: 'Ada Viewer', role: 'viewer' })
    const link = { id: linked.body.ticketId, kind: 'invitation', role: 'viewer', seatId: linked.body.seatId, name: 'Ada Viewer', issuerSeatId: admin.seatId, status: 'link', myStep: null, until: START + 24 * HOUR }
    now += 1 // the list is ordered by time of issue
    const ticket = await issue(o, { displayName: 'New Compliance', role: 'compliance' })
    const base = { id: ticket.body.ticketId, kind: 'invitation', role: 'compliance', seatId: ticket.body.seatId, name: 'New Compliance', issuerSeatId: o.seatId }
    expect(await list(o)).toEqual([link, { ...base, status: 'link', myStep: null, until: now + 10 * MIN }])
    const joined = await enrolLink(ticket.body.link)
    expect(await list(o)).toEqual([link, { ...base, status: 'issuer', myStep: 'issuer', until: now + 60 * MIN }])
    expect(await list(admin)).toEqual([link, { ...base, status: 'issuer', myStep: null, until: now + 60 * MIN }])
    for (const m of [approver, viewer, trader]) expect(await list(m)).toEqual([])
    await confirm(o, ticket.body.ticketId, joined.words, o.key)
    expect(await list(o)).toEqual([link, { ...base, status: 'second', myStep: null, until: now + 60 * MIN }])
    expect(await list(admin)).toEqual([link, { ...base, status: 'second', myStep: 'second', until: now + 60 * MIN }])
    expect(await list(approver)).toEqual([{ ...base, status: 'second', myStep: 'second', until: now + 60 * MIN }])
    for (const m of [viewer, trader]) expect(await list(m)).toEqual([])
    // A ticket whose time is up leaves the list without a write.
    now += 60 * MIN + 1
    expect(await list(await again(o))).toEqual([link])
  })

  it('when one ticket of a seat is confirmed, every other open ticket of that seat dies with its pending passkey', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    const first = await issue(admin, { seatId: viewer.seatId })
    const rival = await enrolLink(first.body.link)
    const unused = await issue(admin, { seatId: viewer.seatId })
    const elsewhere = await issue(admin, { displayName: 'Ada Viewer', role: 'viewer' })
    await ceremony(o, { seatId: viewer.seatId })
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', first.body.ticketId)).toEqual({ state: 'dead' })
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', unused.body.ticketId)).toEqual({ state: 'dead' })
    expect(await credentialState(rival.key)).toBe('revoked')
    expect((await confirm(admin, first.body.ticketId, rival.words, admin.key)).status).toBe(404)
    expect((await enrolLink(unused.body.link)).status).toBe(404)
    expect((await enrolLink(elsewhere.body.link)).status).toBe(200) // another seat's ticket is untouched
  })

  it('an Owner can cancel any ticket, with its pending passkey; nobody else can', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const first = await issue(admin, { displayName: 'Ada Viewer', role: 'viewer' })
    const second = await issue(admin, { displayName: 'Bea Viewer', role: 'viewer' })
    const joined = await enrolLink(second.body.link)
    const cancel = (m: Holder, id: string) => post(`/api/tickets/${id}/cancel`, m)
    expect((await cancel(admin, first.body.ticketId)).body).toEqual({ error: 'forbidden' })
    expect((await enrolLink(first.body.link)).status).toBe(200) // a new member's link still works: the Admin cancelled nothing
    const third = await issue(admin, { displayName: 'Cal Viewer', role: 'viewer' })
    expect((await cancel(o, third.body.ticketId)).status).toBe(200)
    expect((await cancel(o, second.body.ticketId)).status).toBe(200)
    expect((await cancel(o, second.body.ticketId)).status).toBe(404)
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', second.body.ticketId)).toEqual({ state: 'cancelled' })
    expect(await credentialState(joined.key)).toBe('revoked')
    expect((await enrolLink(third.body.link)).status).toBe(404)
    expect((await confirm(admin, second.body.ticketId, joined.words, admin.key)).status).toBe(404)
    expect((await signIn(joined.key)).status).toBe(401)
  })
})

// True when a response gave the phrase away, in any shape: all three words appear among its tokens.
const shows = (bodies: unknown, phrase: string[]) => {
  const tokens = new Set(JSON.stringify(bodies).toLowerCase().split(/[^a-z-]+/))
  return phrase.every((word) => tokens.has(word))
}

describe('n. the three words: the colleague types what the member reads out', () => {
  it('a Viewer joins: the passkey is pending until the issuer types the words, and the issuer is never shown them', async () => {
    const o = await owner()
    const seen: unknown[] = []
    const ticket = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const id = ticket.body.ticketId
    const joined = await enrolLink(ticket.body.link)
    expect(joined.body).toEqual({ state: 'pending', phrase: [expect.any(String), expect.any(String), expect.any(String)], confirmBy: now + 60 * MIN })
    expect(shows(joined.body, joined.body.phrase)).toBe(true)
    // The words are the ones recovery.md derives from the stored rows (derivation: section j).
    const { nonce } = (await row<{ nonce: string }>('SELECT nonce FROM enrolment_tickets WHERE id = ?', id))!
    const { public_key } = (await row<{ public_key: string }>('SELECT public_key FROM credentials WHERE id = ?', joined.key.id))!
    const derived = await phraseFor({ site: 'localhost', orgId: o.orgId, seatId: ticket.body.seatId, role: 'viewer', purpose: 'invitation', credentialHash: await credentialHash(joined.key.id, public_key), nonce })
    expect(joined.body.phrase).toEqual(derived)
    expect((await signIn(joined.key)).status).toBe(401)
    const view = async () => seen.push((await call('GET', '/api/org', { cookie: o.cookie })).body, (await call('GET', '/api/me', { cookie: o.cookie })).body)
    seen.push(ticket.body)
    await view()
    const start = await post(`/api/tickets/${id}/confirm/start`, o)
    seen.push(start.body, (await post(`/api/tickets/${id}/confirm`, o, { words: WRONG, response: await o.key.authenticate(start.body.options) })).body)
    await view()
    const done = await confirm(o, id, joined.words, o.key)
    expect(done.body).toEqual({ state: 'active' })
    seen.push(done.body)
    await view()
    expect(shows(seen, joined.body.phrase)).toBe(false)
    expect(JSON.stringify(seen)).not.toContain(nonce)
    expect(await credentialState(joined.key)).toBe('active')
    expect(await row('SELECT state, quarantine_until FROM seats WHERE id = ?', ticket.body.seatId)).toEqual({ state: 'active', quarantine_until: null })
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', id)).toEqual({ state: 'confirmed' })
    expect((await signIn(joined.key)).status).toBe(200)
    // The audit rows of the whole ceremony hold ids and fixed codes only, and the chain verifies.
    const { results } = await db.prepare('SELECT * FROM audit_log WHERE org_id = ?').bind(o.orgId).all<Record<string, unknown>>()
    for (const entry of results) for (const value of Object.values(entry)) if (typeof value === 'string') expect(value).toMatch(/^[A-Za-z0-9_.-]+$/)
    expect(shows(results, joined.body.phrase)).toBe(false)
    expect(await data.verifyAudit(db, o.orgId)).toMatchObject({ ok: true })
  })

  it('only the issuer confirms, with a passkey check made for this ticket; a failed check or a typing slip costs no attempt', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    const ticket = await issue(admin, { displayName: 'Ada Viewer', role: 'viewer' })
    const id = ticket.body.ticketId
    const joined = await enrolLink(ticket.body.link)
    // The Owner is not the issuer of this ticket. A Viewer is nobody here: the role table refuses it.
    expect((await confirm(o, id, joined.words, o.key)).status).toBe(404)
    expect((await confirm(viewer, id, joined.words, viewer.key)).status).toBe(403)
    const send = (response: unknown, words: unknown = joined.words) => post(`/api/tickets/${id}/confirm`, admin, { words, response })
    // The passkey check must be made for this ticket: not a step-up check, not a check for another ticket,
    // not another member's passkey, not one without user verification.
    expect((await send(await admin.key.authenticate((await post('/api/stepup/start', admin)).body.options))).body).toEqual({ error: 'passkey_rejected' })
    const other = await issue(admin, { displayName: 'Bea Viewer', role: 'viewer' })
    await enrolLink(other.body.link)
    expect((await send(await admin.key.authenticate((await post(`/api/tickets/${other.body.ticketId}/confirm/start`, admin)).body.options))).body).toEqual({ error: 'passkey_rejected' })
    const start = await post(`/api/tickets/${id}/confirm/start`, admin)
    expect((await send(await o.key.authenticate(start.body.options))).body).toEqual({ error: 'passkey_rejected' })
    expect((await send(await admin.key.authenticate(start.body.options, { userVerified: false }))).body).toEqual({ error: 'passkey_rejected' })
    expect((await send(await admin.key.authenticate(start.body.options, { as: { origin: 'https://evil.example' } }))).body).toEqual({ error: 'passkey_rejected' })
    expect((await send(undefined)).body).toEqual({ error: 'passkey_rejected' })
    // Words that are not three words of the list are a typing slip, not a guess.
    for (const words of ['', 'one two', `${WRONG} ${WORDS[0]}`, 'xxxx yyyy zzzz', 7]) expect((await send(await admin.key.authenticate(start.body.options), words)).body).toEqual({ error: 'words_invalid' })
    expect(await row('SELECT attempts, state FROM enrolment_tickets WHERE id = ?', id)).toEqual({ attempts: 0, state: 'stored' })
    expect((await send(await admin.key.authenticate(start.body.options), `  ${joined.words.toUpperCase().replace(/ /g, '   ')} `)).body).toEqual({ state: 'active' })
  })

  it('three wrong tries kill the ticket and the pending passkey; the counter is exact; a fourth try is refused even with the right words', async () => {
    const o = await owner()
    const quiet = (await addKey(o, { counts: false })).key
    const ticket = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const id = ticket.body.ticketId
    const joined = await enrolLink(ticket.body.link)
    const stored = () => row('SELECT attempts, state FROM enrolment_tickets WHERE id = ?', id)
    const first = await confirm(o, id, WRONG, o.key)
    expect(first.status).toBe(400)
    expect(first.body).toEqual({ error: 'wrong_words', left: 2 })
    expect(await stored()).toEqual({ attempts: 1, state: 'stored' })
    // Each try needs its own passkey check: the check of one try is not accepted for the next.
    const start = await post(`/api/tickets/${id}/confirm/start`, o)
    const response = await quiet.authenticate(start.body.options)
    expect((await post(`/api/tickets/${id}/confirm`, o, { words: WRONG, response })).body).toEqual({ error: 'wrong_words', left: 1 })
    expect((await post(`/api/tickets/${id}/confirm`, o, { words: joined.words, response })).body).toEqual({ error: 'passkey_rejected' })
    expect(await stored()).toEqual({ attempts: 2, state: 'stored' })
    const third = await confirm(o, id, WRONG, o.key)
    expect(third.status).toBe(410)
    expect(third.body).toEqual({ error: 'ticket_dead' })
    expect(await stored()).toEqual({ attempts: 3, state: 'dead' })
    expect(await credentialState(joined.key)).toBe('revoked')
    expect((await confirm(o, id, joined.words, o.key)).status).toBe(404)
    expect(await stored()).toEqual({ attempts: 3, state: 'dead' })
    expect((await signIn(joined.key)).status).toBe(401)
    // Two requests with one passkey check at the same instant count one try, not two.
    const raced = await issue(o, { displayName: 'Cal Viewer', role: 'viewer' })
    await enrolLink(raced.body.link)
    const path = `/api/tickets/${raced.body.ticketId}/confirm`
    const body = { words: WRONG, response: await quiet.authenticate((await post(`${path}/start`, o)).body.options) }
    let other = { status: 0 }
    const late = await call('POST', path, { cookie: o.cookie, body, env: racing(async () => (other = await post(path, o, body))) })
    expect([other.status, late.status]).toEqual([400, 409])
    expect(late.body).toEqual({ error: 'try_again' })
    expect(await row('SELECT attempts FROM enrolment_tickets WHERE id = ?', raced.body.ticketId)).toEqual({ attempts: 1 })
    // Two wrong tries, then the right words: still accepted.
    const next = await issue(o, { displayName: 'Bea Viewer', role: 'viewer' })
    const again2 = await enrolLink(next.body.link)
    for (const left of [2, 1]) expect((await confirm(o, next.body.ticketId, WRONG, o.key)).body).toEqual({ error: 'wrong_words', left })
    expect((await confirm(o, next.body.ticketId, again2.words, o.key)).body).toEqual({ state: 'active' })
  })

  it('the words must be typed within 60 minutes of the enrolment', async () => {
    const o = await owner()
    const late = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const joined = await enrolLink(late.body.link)
    now += 60 * MIN + 1
    await again(o)
    expect((await confirm(o, late.body.ticketId, joined.words, o.key)).status).toBe(404)
    expect(await credentialState(joined.key)).toBe('pending')
    expect((await signIn(joined.key)).status).toBe(401)
    const onTime = await issue(o, { displayName: 'Bea Viewer', role: 'viewer' })
    const second = await enrolLink(onTime.body.link)
    now += 60 * MIN
    // At the last millisecond the passkey is still pending: only the issuer's words activate it, never a sign-in.
    expect((await signIn(second.key)).status).toBe(401)
    expect(await credentialState(second.key)).toBe('pending')
    await again(o)
    expect((await confirm(o, onTime.body.ticketId, second.words, o.key)).body).toEqual({ state: 'active' })
  })

  it('a ticket is dead once its seat is not in the right state', async () => {
    const o = await owner()
    const ticket = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const joined = await enrolLink(ticket.body.link)
    await db.prepare(`UPDATE seats SET state = 'removed' WHERE id = ?`).bind(ticket.body.seatId).run()
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).status).toBe(404)
    await db.prepare(`UPDATE seats SET state = 'invited', role = 'trader' WHERE id = ?`).bind(ticket.body.seatId).run()
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).status).toBe(404)
    expect(await credentialState(joined.key)).toBe('pending')
  })

  it('a key role needs a second person: not the issuer, not the target, and a key role', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const approver = await colleague(o, 'approver')
    const trader = await colleague(o, 'trader')
    const ticket = await issue(o, { displayName: 'New Compliance', role: 'compliance' })
    const id = ticket.body.ticketId
    const joined = await enrolLink(ticket.body.link)
    expect((await confirm(o, id, joined.words, o.key)).body).toEqual({ state: 'second' })
    expect(await credentialState(joined.key)).toBe('pending')
    expect((await signIn(joined.key)).status).toBe(401)
    // The issuer cannot be the second person. A Trader cannot be either.
    expect((await confirm(o, id, joined.words, o.key)).status).toBe(404)
    expect((await confirm(trader, id, joined.words, trader.key)).status).toBe(403)
    expect(await credentialState(joined.key)).toBe('pending')
    // The second person's wrong words count on the same counter.
    expect((await confirm(approver, id, WRONG, approver.key)).body).toEqual({ error: 'wrong_words', left: 2 })
    expect((await confirm(approver, id, joined.words, approver.key)).body).toEqual({ state: 'active' })
    expect(await row('SELECT requester_seat_id, checker_seat_id, state, subject_id FROM approvals WHERE org_id = ?', o.orgId))
      .toEqual({ requester_seat_id: o.seatId, checker_seat_id: approver.seatId, state: 'applied', subject_id: id })
    expect((await signIn(joined.key)).status).toBe(200)
    // The target is not its own second person, even while its old passkey still holds a session.
    const re = await issue(o, { seatId: admin.seatId })
    const replaced = await enrolLink(re.body.link)
    expect((await confirm(o, re.body.ticketId, replaced.words, o.key)).body).toEqual({ state: 'second' })
    expect((await confirm(admin, re.body.ticketId, replaced.words, admin.key)).status).toBe(404)
    // The second person has the same 60 minutes.
    now += 60 * MIN + 1
    await again(approver)
    expect((await confirm(approver, re.body.ticketId, replaced.words, approver.key)).status).toBe(404)
    expect(await credentialState(replaced.key)).toBe('pending')
  })

  it('with no second person, a 72 hour wait replaces that step, and not one millisecond less', async () => {
    const o = await owner() // the only key-role member
    await colleague(o, 'trader') // not a key role: does not count as a second person
    const ticket = await issue(o, { displayName: 'First Admin', role: 'admin' })
    const joined = await enrolLink(ticket.body.link)
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).body).toEqual({ state: 'wait', waitUntil: START + 72 * HOUR })
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).status).toBe(404)
    for (const at of [START + 1, START + 71 * HOUR, START + 72 * HOUR - 1]) {
      now = at
      expect((await signIn(joined.key)).status).toBe(401)
      expect(await credentialState(joined.key)).toBe('pending')
    }
    now = START + 72 * HOUR
    expect((await signIn(joined.key)).status).toBe(200)
    expect(await credentialState(joined.key)).toBe('active')
    expect(await row('SELECT state FROM seats WHERE id = ?', ticket.body.seatId)).toEqual({ state: 'active' })
    expect(await row('SELECT state, checker_seat_id FROM approvals WHERE org_id = ?', o.orgId)).toEqual({ state: 'applied', checker_seat_id: null })
    expect(await data.verifyAudit(db, o.orgId)).toMatchObject({ ok: true })
    // After the wait the new passkey has 7 days to sign in, and no longer.
    const lonely = await owner()
    const late = await issue(lonely, { displayName: 'An Approver', role: 'approver' })
    const slow = await enrolLink(late.body.link)
    const t0 = now
    expect((await confirm(lonely, late.body.ticketId, slow.words, lonely.key)).body).toEqual({ state: 'wait', waitUntil: t0 + 72 * HOUR })
    now = t0 + (72 + 7 * 24) * HOUR + 1
    expect((await signIn(slow.key)).status).toBe(401)
    now -= 1
    expect((await signIn(slow.key)).status).toBe(200)
  })

  it('during the wait any Owner can cancel; the re-enrolment of a key-role member never waits, and their own sign-in closes it', async () => {
    const o = await owner()
    // A one-person organisation invites its first Admin: the wait (section u). The Owner cancels during it.
    const ticket = await issue(o, { displayName: 'First Admin', role: 'admin' })
    const joined = await enrolLink(ticket.body.link)
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).body).toEqual({ state: 'wait', waitUntil: START + 72 * HOUR })
    now = START + 71 * HOUR
    expect((await post(`/api/tickets/${ticket.body.ticketId}/cancel`, await again(o))).status).toBe(200)
    now = START + 72 * HOUR
    expect((await signIn(joined.key)).status).toBe(401)
    expect(await credentialState(joined.key)).toBe('revoked')
    // The Admin's re-enrolment has no second person and gets no wait. The real Admin still has a passkey: signing in closes it.
    const admin = await colleague(o, 'admin')
    const second = await issue(await again(o), { seatId: admin.seatId })
    const other = await enrolLink(second.body.link)
    expect((await confirm(o, second.body.ticketId, other.words, o.key)).body).toEqual({ state: 'second' })
    await again(admin)
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', second.body.ticketId)).toEqual({ state: 'dead' })
    expect(await credentialState(other.key)).toBe('revoked')
    now += 72 * HOUR
    expect((await signIn(other.key)).status).toBe(401)
    expect((await signIn(admin.key)).status).toBe(200)
  })
})

describe('o. re-enrolment: suspended passkeys, the stop right, quarantine', () => {
  // A seat re-enrolled by the Owner: target.key and target.key2 are the replaced passkeys, `fresh` is the new one.
  async function replaced(role = 'viewer') {
    const o = await owner()
    const second = role === 'viewer' || role === 'trader' ? undefined : await colleague(o, 'approver')
    const target = await colleague(o, role)
    const done = await ceremony(o, { seatId: target.seatId }, second)
    return { o, target, fresh: done.key, at: now }
  }
  const seat = (id: string) => row('SELECT state, quarantine_until FROM seats WHERE id = ?', id)

  it('the previous passkeys are suspended, not deleted; the sessions of the seat end; quarantine starts: 24 hours, or 72 for a key role', async () => {
    const v = await replaced()
    for (const key of [v.target.key, v.target.key2]) {
      expect(await row('SELECT state, stop_right_until FROM credentials WHERE id = ?', key.id)).toEqual({ state: 'suspended', stop_right_until: now + 24 * HOUR })
    }
    expect(await seat(v.target.seatId)).toEqual({ state: 'active', quarantine_until: now + 24 * HOUR })
    expect((await call('GET', '/api/me', { cookie: v.target.cookie })).status).toBe(401)
    expect(await row('SELECT count(*) AS open FROM sessions WHERE seat_id = ? AND revoked_at IS NULL', v.target.seatId)).toEqual({ open: 0 })
    expect((await signIn(v.fresh)).status).toBe(200)
    expect(await credentialState(v.o.key)).toBe('active') // the issuer's own passkeys are untouched
    for (const role of ['trader', 'admin', 'approver', 'compliance']) {
      const r = await replaced(role)
      const hours = role === 'trader' ? 24 : 72
      expect(await seat(r.target.seatId), role).toEqual({ state: 'active', quarantine_until: now + hours * HOUR })
      expect(await row('SELECT state, stop_right_until FROM credentials WHERE id = ?', r.target.key.id), role).toEqual({ state: 'suspended', stop_right_until: now + hours * HOUR })
    }
  })

  it('a suspended passkey opens no session; it can stop its replacement until quarantine ends', async () => {
    const v = await replaced()
    const session = await again({ key: v.fresh, cookie: '' })
    const sessions = await count('sessions', v.o.orgId)
    const refused = await signIn(v.target.key)
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: 'passkey_replaced', until: v.at + 24 * HOUR })
    expect(refused.headers.get('set-cookie')).toBeNull()
    expect(await count('sessions', v.o.orgId)).toBe(sessions)
    // A passkey nobody verified learns nothing about the replacement.
    expect((await signIn(v.target.key, { as: { origin: 'https://evil.example' } })).body).toEqual({ error: 'sign_in_failed' })
    now = v.at + 24 * HOUR - 1
    const stopped = await stop(v.target.key)
    expect(stopped.status).toBe(200)
    expect(stopped.body).toEqual({ ok: true })
    // The new passkey is revoked and opens no session; the old ones are active again; the seat is frozen.
    expect(await credentialState(v.fresh)).toBe('revoked')
    expect((await signIn(v.fresh)).status).toBe(401)
    expect((await call('GET', '/api/me', { cookie: session.cookie })).status).toBe(401)
    for (const key of [v.target.key, v.target.key2]) {
      expect(await row('SELECT state, stop_right_until FROM credentials WHERE id = ?', key.id)).toEqual({ state: 'active', stop_right_until: null })
    }
    expect(await seat(v.target.seatId)).toEqual({ state: 'frozen', quarantine_until: null })
    expect((await signIn(v.target.key)).body).toEqual({ error: 'seat_frozen', by: 'A viewer', at: now, stopped: true }) // no session: two people unfreeze (section t)
    expect((await stop(v.target.key)).status).toBe(401)
    const last = await row('SELECT action, actor_id, subject_id FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1', v.o.orgId)
    expect(last).toEqual({ action: 'credential.stop', actor_id: v.target.seatId, subject_id: v.target.key.id })
    // Not an Owner alone: the passkeys of a frozen seat are not revoked one by one.
    expect((await post(`/api/passkeys/${v.target.key.id}/revoke`, await again(v.o))).status).toBe(404)
    expect(await credentialState(v.target.key)).toBe('active')
    expect(await data.verifyAudit(db, v.o.orgId)).toMatchObject({ ok: true })
  })

  it('and not one minute later: once quarantine has ended the replaced passkey can do nothing', async () => {
    for (const [role, hours] of [['viewer', 24], ['admin', 72]] as const) {
      const v = await replaced(role)
      now = v.at + hours * HOUR
      expect((await stop(v.target.key)).status).toBe(401)
      expect((await signIn(v.target.key)).body).toEqual({ error: 'sign_in_failed' })
      expect(await credentialState(v.fresh)).toBe('active')
      expect(await credentialState(v.target.key)).toBe('suspended')
      expect((await signIn(v.fresh)).status).toBe(200)
      if (role === 'admin') {
        // A key role keeps the right for the whole 72 hours.
        const w = await replaced(role)
        now = w.at + hours * HOUR - 1
        expect((await stop(w.target.key2)).status).toBe(200)
      }
    }
  })

  it('a stop answers only a stop challenge, from a replaced passkey', async () => {
    const v = await replaced()
    // A sign-in challenge does not pass as a stop challenge, and the reverse.
    const signin = await call('POST', '/api/signin/start')
    expect((await call('POST', '/api/stop/finish', { body: { response: await v.target.key.authenticate(signin.body.options) } })).status).toBe(401)
    const start = await call('POST', '/api/stop/start')
    expect((await call('POST', '/api/signin/finish', { body: { response: await v.o.key.authenticate(start.body.options) } })).status).toBe(401)
    // An active passkey stops nothing: not the new passkey, not a colleague's.
    expect((await stop(v.fresh)).status).toBe(401)
    expect((await stop(v.o.key)).status).toBe(401)
    expect((await stop(v.target.key, { as: { origin: 'https://evil.example' } })).status).toBe(401)
    expect((await stop(v.target.key, { userVerified: false })).status).toBe(401)
    expect((await stop(v.target.key, { userHandle: userHandle(v.o.seatId) })).status).toBe(401)
    expect((await call('POST', '/api/stop/finish', { body: {} })).body).toEqual({ error: 'sign_in_failed' })
    expect(await credentialState(v.fresh)).toBe('active')
    expect(await seat(v.target.seatId)).toMatchObject({ state: 'active' })
    expect((await stop(v.target.key2)).status).toBe(200) // either of the replaced passkeys
  })

  it('two stops at the same instant: the second changes nothing, and the restored passkeys stay active', async () => {
    const v = await replaced()
    const start = await call('POST', '/api/stop/start')
    const body = { response: await v.target.key.authenticate(start.body.options) }
    let first = { status: 0 }
    const second = await call('POST', '/api/stop/finish', { body, env: racing(async () => (first = await stop(v.target.key2))) })
    expect([first.status, second.status]).toEqual([200, 401])
    expect(await credentialState(v.target.key)).toBe('active')
    expect(await credentialState(v.target.key2)).toBe('active')
    expect(await credentialState(v.fresh)).toBe('revoked')
  })

  it('during quarantine the re-enrolled seat cannot add a member or revoke a colleague\'s passkey; reading, its own second passkey and re-enrolments stay open', async () => {
    const o = await owner()
    const approver = await colleague(o, 'approver')
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    const done = await ceremony(o, { seatId: admin.seatId }, approver)
    const at = now
    const fresh = await again({ key: done.key, cookie: '' })
    expect((await addKey(fresh)).status).toBe(200) // "The member adds the second passkey in the same session."
    const quarantine = { error: 'quarantine' }
    const blocked = await issue(fresh, { displayName: 'New Viewer', role: 'viewer' })
    expect(blocked.status).toBe(403)
    expect(blocked.body).toEqual(quarantine)
    expect((await post(`/api/passkeys/${viewer.key2.id}/revoke`, fresh)).body).toEqual(quarantine)
    // Typing the words for a new member, as the second person, adds a member too.
    const invitation = await issue(o, { displayName: 'New Approver', role: 'approver' })
    const joined = await enrolLink(invitation.body.link)
    expect((await confirm(o, invitation.body.ticketId, joined.words, o.key)).body).toEqual({ state: 'second' })
    expect((await post(`/api/tickets/${invitation.body.ticketId}/confirm/start`, fresh)).body).toEqual(quarantine)
    expect(await count('seats', o.orgId)).toBe(5)
    expect(await credentialState(viewer.key2)).toBe('active')
    expect(await credentialState(joined.key)).toBe('pending')
    // Still open: reading, and re-enrolling an existing seat.
    expect((await call('GET', '/api/org', { cookie: fresh.cookie })).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: fresh.cookie })).body.seat.quarantineUntil).toBe(at + 72 * HOUR)
    expect((await issue(fresh, { seatId: viewer.seatId })).status).toBe(200)
    // 72 hours for a key role, to the millisecond.
    now = at + 72 * HOUR - 1
    await again(fresh)
    expect((await issue(fresh, { displayName: 'New Viewer', role: 'viewer' })).body).toEqual(quarantine)
    now = at + 72 * HOUR
    await again(fresh)
    expect((await issue(fresh, { displayName: 'New Viewer', role: 'viewer' })).status).toBe(200)
    expect((await post(`/api/passkeys/${viewer.key2.id}/revoke`, fresh)).status).toBe(200)
  })

  it('if the target signs in with an old passkey while a re-enrolment ticket is open, the ticket dies', async () => {
    const o = await owner()
    const viewer = await colleague(o, 'viewer')
    const open = await issue(o, { seatId: viewer.seatId })
    const stored = await issue(o, { seatId: viewer.seatId })
    const joined = await enrolLink(stored.body.link)
    const invitation = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    await again(viewer)
    for (const ticket of [open, stored]) expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', ticket.body.ticketId)).toEqual({ state: 'dead' })
    expect(await credentialState(joined.key)).toBe('revoked')
    expect((await enrolLink(open.body.link)).status).toBe(404)
    expect((await confirm(o, stored.body.ticketId, joined.words, o.key)).status).toBe(404)
    // The issuer is flagged in the log; a colleague's invitation is untouched.
    expect(await row('SELECT action, detail FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1', o.orgId)).toEqual({ action: 'session.create', detail: 'ticket_killed' })
    expect((await enrolLink(invitation.body.link)).status).toBe(200)
    await again(viewer)
    expect(await row('SELECT action, detail FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1', o.orgId)).toEqual({ action: 'session.create', detail: null })
    // The sign-in closes the tickets for the member's own seat, not the ones the member issued for others.
    const admin = await colleague(o, 'admin')
    const theirs = await issue(admin, { displayName: 'Bea Viewer', role: 'viewer' })
    const onAdmin = await issue(o, { seatId: admin.seatId })
    await again(admin)
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', onAdmin.body.ticketId)).toEqual({ state: 'dead' })
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', theirs.body.ticketId)).toEqual({ state: 'issued' })
  })
})

describe('p. alerts shown at sign-in (no email is sent)', () => {
  // (The colleagues of these tests joined minutes ago, which is an alert of its own: section q.)
  const alerts = async (m: Holder) => ((await call('GET', '/api/me', { cookie: m.cookie })).body.alerts as { kind: string; name?: string; until?: number }[]).filter((alert) => alert.kind !== 'colleague_joined')
  const kinds = async (m: Holder) => (await alerts(m)).map((alert) => alert.kind).sort()

  it('a new passkey on the seat: the next sign-in is told, the session that added it is not', async () => {
    const m = await member()
    expect(await kinds(m)).toEqual([])
    const added = await addKey(m)
    expect(await kinds(m)).toEqual([])
    const next = await again({ key: added.key, cookie: '' })
    expect(await kinds(next)).toEqual(['new_passkey'])
    now += 7 * 24 * HOUR + 1
    expect(await kinds(await again(next))).toEqual([])
  })

  it('a re-enrolment: the member, the people who must type the words, then every member', async () => {
    const o = await owner()
    const approver = await colleague(o, 'approver')
    const trader = await colleague(o, 'trader')
    const admin = await colleague(o, 'admin')
    const elsewhere = await owner()
    expect(await kinds(admin)).toEqual([])
    const ticket = await issue(o, { seatId: admin.seatId })
    expect(await kinds(admin)).toEqual(['re_enrolment_started'])
    const joined = await enrolLink(ticket.body.link)
    expect(await alerts(o)).toEqual([{ key: `wait:${ticket.body.ticketId}:issuer`, kind: 'confirmation_waiting', name: 'A admin' }])
    expect(await kinds(approver)).toEqual([])
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).body).toEqual({ state: 'second' })
    expect(await kinds(o)).toEqual([])
    expect(await kinds(approver)).toEqual(['confirmation_waiting'])
    expect((await confirm(approver, ticket.body.ticketId, joined.words, approver.key)).body).toEqual({ state: 'active' })
    const at = now
    const fresh = await again({ key: joined.key, cookie: '' })
    // (new_passkey: the Admin added a second passkey from another session in the last 7 days.)
    expect(await kinds(fresh)).toEqual(['new_passkey', 'quarantine', 're_enrolment_completed'])
    expect((await alerts(fresh)).find((alert) => alert.kind === 'quarantine')).toMatchObject({ until: at + 72 * HOUR })
    // Every other member is told; the issuer is not told what they did themselves.
    expect(await alerts(trader)).toEqual([expect.objectContaining({ kind: 'colleague_re_enrolled', name: 'A admin' })])
    expect(await kinds(approver)).toEqual(['colleague_re_enrolled'])
    expect(await kinds(o)).toEqual([])
    // The real Admin stops it: every member sees the frozen seat.
    expect((await stop(admin.key)).status).toBe(200)
    expect(await alerts(o)).toContainEqual(expect.objectContaining({ kind: 'seat_frozen', name: 'A admin' }))
    expect(await kinds(approver)).toContain('seat_frozen')
    // Another organisation hears nothing of it.
    expect(await kinds(elsewhere)).toEqual([])
    expect(JSON.stringify(await alerts(o))).not.toContain(elsewhere.orgId)
  })
})

// ---- independent review, 2026-11-11: the attacks of recovery.md section 16, tried through the routes ----

describe('q. attacks tried by the reviewer', () => {
  it('a colleague cannot clear the way for a re-enrolment: the last passkey of a colleague is not revoked, and a frozen seat gets no passkey', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const trader = await colleague(o, 'trader')
    const revoke = (key: Key) => post(`/api/passkeys/${key.id}/revoke`, admin)
    const seat = () => row<{ state: string }>('SELECT state FROM seats WHERE id = ?', trader.seatId)
    // A re-enrolment the Admin started, with the Admin's own key on it.
    const ticket = await issue(admin, { seatId: trader.seatId })
    const own = await enrolLink(ticket.body.link)
    // One of two: a one-person action. The member still signs in, and the passkey that is left keeps the stop right.
    expect((await revoke(trader.key2)).status).toBe(200)
    expect(await seat()).toEqual({ state: 'active' })
    // The last one stays: with no passkey left the real member could stop nothing.
    const last = await revoke(trader.key)
    expect([last.status, last.body]).toEqual([409, { error: 'last_passkey' }])
    expect(await credentialState(trader.key)).toBe('active')
    expect(await seat()).toEqual({ state: 'active' })
    // What one person can do at once is freeze the seat, and a frozen seat gets no new passkey: not from the open ticket, not from a new one.
    expect((await act(admin, trader.seatId, 'freeze')).status).toBe(200)
    expect(await seat()).toEqual({ state: 'frozen' })
    expect(await credentialState(trader.key)).toBe('suspended')
    expect((await confirm(admin, ticket.body.ticketId, own.words, admin.key)).status).toBe(404)
    expect((await issue(admin, { seatId: trader.seatId })).status).toBe(404)
    expect(await credentialState(own.key)).toBe('revoked')
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', ticket.body.ticketId)).toEqual({ state: 'dead' })
    expect((await signIn(own.key)).status).toBe(401)
    // Every member is told.
    expect((await call('GET', '/api/me', { cookie: o.cookie })).body.alerts).toContainEqual(expect.objectContaining({ kind: 'seat_frozen', name: 'A trader', by: 'A admin' }))
    // The member's own revoke: one of two, yes.
    await stepUp(admin, admin.key)
    expect((await post(`/api/passkeys/${admin.key2.id}/revoke`, admin)).status).toBe(200)
    expect(await row('SELECT state FROM seats WHERE id = ?', admin.seatId)).toEqual({ state: 'active' })
  })

  it('a ticket is dead once the seat that issued it is no longer active: a stop also ends what the stopped passkey had started', async () => {
    const o = await owner()
    const approver = await colleague(o, 'approver')
    const compliance = await colleague(o, 'compliance')
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    // The Admin seat is taken through a re-enrolment. Its new holder starts re-enrolments, which quarantine leaves open.
    const taken = await ceremony(o, { seatId: admin.seatId }, approver)
    const thief = await again({ key: taken.key, cookie: '' })
    expect((await addKey(thief)).status).toBe(200)
    const link = await issue(thief, { seatId: viewer.seatId })
    const half = await issue(thief, { seatId: compliance.seatId })
    const joined = await enrolLink(half.body.link)
    expect((await confirm(thief, half.body.ticketId, joined.words, thief.key)).body).toEqual({ state: 'second' })
    // The real Admin stops the replacement. What the seat had issued is dead in the tables, so that
    // unfreezing the seat later (two people, section t) brings none of it back.
    expect((await stop(admin.key)).status).toBe(200)
    for (const ticket of [link, half]) expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', ticket.body.ticketId)).toEqual({ state: 'dead' })
    expect(await credentialState(joined.key)).toBe('revoked')
    await db.prepare(`UPDATE seats SET state = 'active' WHERE id = ?`).bind(admin.seatId).run()
    expect((await call('POST', '/api/enrol/start', { body: { ticket: link.body.link.split('#/enrol/')[1] } })).status).toBe(404)
    await again(o)
    expect((await call('GET', '/api/org', { cookie: o.cookie })).body.tickets).toEqual([])
    expect((await confirm(o, half.body.ticketId, joined.words, o.key)).status).toBe(404)
    expect(await credentialState(compliance.key)).toBe('active')
    // The same when a colleague freezes the issuer.
    const frozen = await colleague(o, 'admin')
    const theirs = await issue(frozen, { displayName: 'Ada Viewer', role: 'viewer' })
    expect((await act(o, frozen.seatId, 'freeze')).status).toBe(200)
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', theirs.body.ticketId)).toEqual({ state: 'dead' })
    // And whatever takes a seat out of the active state (removal, milestone 3): its link and its 72 hour wait are dead when read.
    const lonely = await owner()
    const invited = await issue(lonely, { displayName: 'First Admin', role: 'admin' })
    const waiting = await enrolLink(invited.body.link)
    expect((await confirm(lonely, invited.body.ticketId, waiting.words, lonely.key)).body.state).toBe('wait')
    const unused = await issue(lonely, { displayName: 'Ada Viewer', role: 'viewer' })
    await db.prepare(`UPDATE seats SET state = 'removed' WHERE id = ?`).bind(lonely.seatId).run()
    expect((await call('POST', '/api/enrol/start', { body: { ticket: unused.body.link.split('#/enrol/')[1] } })).status).toBe(404)
    now += 72 * HOUR
    expect((await signIn(waiting.key)).status).toBe(401)
    expect(await credentialState(waiting.key)).toBe('pending')
  })

  it('a link opened in two browsers at the same instant stores one passkey, and the other browser is shown no words', async () => {
    const o = await owner()
    const ticket = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const token = ticket.body.link.split('#/enrol/')[1]
    let n = 0
    const body = async () => ({ ticket: token, label: `Key ${++n}`, response: await (await softwareAuthenticator(SITE)).register((await call('POST', '/api/enrol/start', { body: { ticket: token } })).body.options) })
    const [first, second] = [await body(), await body()]
    let won = { status: 0 }
    const lost = await call('POST', '/api/enrol/finish', { body: second, env: racing(async () => (won = await call('POST', '/api/enrol/finish', { body: first }))) })
    expect([won.status, lost.status]).toEqual([200, 409])
    expect(lost.body).toEqual({ error: 'not_stored' })
    expect(await row('SELECT count(*) AS n FROM credentials WHERE ticket_id = ?', ticket.body.ticketId)).toEqual({ n: 1 })
  })

  it('two confirmations with the right words at the same instant activate once', async () => {
    const o = await owner()
    const quiet = (await addKey(o, { counts: false })).key
    const ticket = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const joined = await enrolLink(ticket.body.link)
    const path = `/api/tickets/${ticket.body.ticketId}/confirm`
    const body = { words: joined.words, response: await quiet.authenticate((await post(`${path}/start`, o)).body.options) }
    let first = { status: 0 }
    const second = await call('POST', path, { cookie: o.cookie, body, env: racing(async () => (first = await post(path, o, body))) })
    expect([first.status, second.status]).toEqual([200, 409])
    expect(await row(`SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'credential.activate'`, o.orgId)).toEqual({ n: 1 })
    expect(await data.verifyAudit(db, o.orgId)).toMatchObject({ ok: true })
  })

  it('the 72 hour wait is not shortened by a second person who appears later', async () => {
    const o = await owner()
    const approver = await colleague(o, 'approver')
    // Not a member yet when the wait starts (a frozen or removed key-role seat would refuse the wait: section u).
    await db.prepare(`UPDATE seats SET state = 'invited' WHERE id = ?`).bind(approver.seatId).run()
    const ticket = await issue(o, { displayName: 'First Admin', role: 'admin' })
    const joined = await enrolLink(ticket.body.link)
    expect((await confirm(o, ticket.body.ticketId, joined.words, o.key)).body).toEqual({ state: 'wait', waitUntil: START + 72 * HOUR })
    await db.prepare(`UPDATE seats SET state = 'active' WHERE id = ?`).bind(approver.seatId).run()
    await again(approver)
    expect((await confirm(approver, ticket.body.ticketId, joined.words, approver.key)).status).toBe(404)
    now = START + 72 * HOUR - 1
    expect((await signIn(joined.key)).status).toBe(401)
    expect(await credentialState(joined.key)).toBe('pending')
  })

  it('a ticket cancelled or killed while its link is being used stays dead: no passkey is stored and no words are shown', async () => {
    const o = await owner()
    const viewer = await colleague(o, 'viewer')
    const finishing = async (link: string) => {
      const token = link.split('#/enrol/')[1]
      const key = await softwareAuthenticator(SITE)
      return { key, body: { ticket: token, label: 'Key', response: await key.register((await call('POST', '/api/enrol/start', { body: { ticket: token } })).body.options) } }
    }
    // The Owner cancels at the instant the link is used.
    const invitation = await issue(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const first = await finishing(invitation.body.link)
    let cancelled = { status: 0 }
    const late = await call('POST', '/api/enrol/finish', { body: first.body, env: racing(async () => (cancelled = await post(`/api/tickets/${invitation.body.ticketId}/cancel`, o))) })
    expect([cancelled.status, late.status]).toEqual([200, 409])
    expect(late.body).toEqual({ error: 'not_stored' })
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', invitation.body.ticketId)).toEqual({ state: 'cancelled' })
    expect(await credentialState(first.key)).toBeUndefined()
    // The member signs in with a passkey they still hold at the instant a re-enrolment link is used.
    const re = await issue(o, { seatId: viewer.seatId })
    const second = await finishing(re.body.link)
    const stolen = await call('POST', '/api/enrol/finish', { body: second.body, env: racing(() => again(viewer)) })
    expect(stolen.status).toBe(409)
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', re.body.ticketId)).toEqual({ state: 'dead' })
    expect(await credentialState(second.key)).toBeUndefined()
    expect((await call('GET', '/api/org', { cookie: (await again(o)).cookie })).body.tickets).toEqual([])
  })

  it('replaced and pending passkeys do not count: not toward the two a seat needs, not toward the 10 it may hold', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const viewer = await colleague(o, 'viewer')
    // The Viewer is re-enrolled: one active passkey, two suspended ones, and then a pending one from a second link.
    const done = await ceremony(admin, { seatId: viewer.seatId })
    const fresh = await again({ key: done.key, cookie: '' })
    await enrolLink((await issue(o, { seatId: viewer.seatId })).body.link)
    expect(await row(`SELECT group_concat(state) AS states FROM (SELECT state FROM credentials WHERE seat_id = ? ORDER BY state)`, viewer.seatId)).toEqual({ states: 'active,pending,suspended,suspended' })
    expect((await call('GET', '/api/me', { cookie: fresh.cookie })).body.seat.keys).toBe(1)
    expect((await post(`/api/passkeys/${done.key.id}/revoke`, fresh)).body).toEqual({ error: 'second_key_required' })
    // Eight replaced passkeys from earlier rounds do not stop the member from adding the second one.
    for (let n = 0; n < 6; n++) {
      await db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, created_at) VALUES (?, ?, ?, 'AA', 0, 1, '[]', ?, 'suspended', ?)`)
        .bind(data.randomId(), o.orgId, viewer.seatId, `Old key ${n}`, now).run()
    }
    expect(await row('SELECT count(*) AS n FROM credentials WHERE seat_id = ?', viewer.seatId)).toEqual({ n: 10 })
    expect((await addKey(fresh)).status).toBe(200)
    expect((await call('GET', '/api/me', { cookie: fresh.cookie })).body.seat.keys).toBe(2)
  })

  it('a stop revokes every passkey the replacement added; on a frozen seat a replaced passkey is told nothing and stops nothing', async () => {
    const o = await owner()
    const target = await colleague(o, 'viewer')
    const done = await ceremony(o, { seatId: target.seatId })
    const thief = await again({ key: done.key, cookie: '' })
    const added = await addKey(thief)
    expect(added.status).toBe(200)
    expect((await post(`/api/passkeys/${done.key.id}/revoke`, thief)).status).toBe(200) // the thief keeps only the key it added itself
    expect((await stop(target.key)).status).toBe(200)
    expect(await credentialState(added.key)).toBe('revoked')
    expect((await signIn(added.key)).status).toBe(401)
    // A seat frozen by a colleague while its replaced passkeys still had their right.
    const other = await colleague(o, 'viewer')
    await ceremony(await again(o), { seatId: other.seatId })
    expect((await act(o, other.seatId, 'freeze')).status).toBe(200)
    expect(await row('SELECT state FROM seats WHERE id = ?', other.seatId)).toEqual({ state: 'frozen' })
    expect((await signIn(other.key)).body).toEqual({ error: 'sign_in_failed' })
    expect((await stop(other.key)).status).toBe(401)
    expect(await credentialState(other.key)).toBe('suspended')
  })

  it('the second person is never shown the words either', async () => {
    const o = await owner()
    const approver = await colleague(o, 'approver')
    const ticket = await issue(o, { displayName: 'New Admin', role: 'admin' })
    const joined = await enrolLink(ticket.body.link)
    const id = ticket.body.ticketId
    expect((await confirm(o, id, joined.words, o.key)).body).toEqual({ state: 'second' })
    const seen: unknown[] = [(await call('GET', '/api/org', { cookie: approver.cookie })).body, (await call('GET', '/api/me', { cookie: approver.cookie })).body]
    const start = await post(`/api/tickets/${id}/confirm/start`, approver)
    seen.push(start.body, (await post(`/api/tickets/${id}/confirm`, approver, { words: WRONG, response: await approver.key.authenticate(start.body.options) })).body)
    const done = await confirm(approver, id, joined.words, approver.key)
    expect(done.body).toEqual({ state: 'active' })
    seen.push(done.body, (await call('GET', '/api/org', { cookie: approver.cookie })).body, (await call('GET', '/api/me', { cookie: approver.cookie })).body)
    expect(seen).toHaveLength(7)
    expect(shows(seen, joined.body.phrase)).toBe(false)
  })

  it('every member is told when a colleague joins, and Owners and Admins when a sign-in closed a re-enrolment', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const trader = await colleague(o, 'trader')
    const alerts = async (m: Holder) => (await call('GET', '/api/me', { cookie: m.cookie })).body.alerts as { kind: string; name?: string }[]
    const joiners = async (m: Holder) => (await alerts(m)).filter((alert) => alert.kind === 'colleague_joined').map((alert) => alert.name).sort()
    // A new member: everyone but the issuer and the new member is told (recovery.md step 8).
    // (The Owner issued the tickets of the Admin and the Trader, so the Owner is not told about those two.)
    const joined = await ceremony(admin, { displayName: 'Ada Viewer', role: 'viewer' })
    expect(await joiners(o)).toEqual(['Ada Viewer'])
    expect(await joiners(trader)).toEqual(['A admin', 'Ada Viewer'])
    expect(await joiners(admin)).toEqual(['A trader'])
    expect(await joiners(await again({ key: joined.key, cookie: '' }))).toEqual(['A admin', 'A trader'])
    // An invitation that was never confirmed tells nobody.
    await enrolLink((await issue(admin, { displayName: 'Bea Viewer', role: 'viewer' })).body.link)
    expect(await joiners(o)).toEqual(['Ada Viewer'])
    // The Admin starts a re-enrolment of the Trader; the Trader signs in with a passkey they still hold.
    await issue(admin, { seatId: trader.seatId })
    await again(trader)
    for (const m of [o, admin]) expect(await alerts(m), m === o ? 'owner' : 'admin').toContainEqual(expect.objectContaining({ kind: 're_enrolment_closed', name: 'A trader' }))
    for (const m of [trader, await again({ key: joined.key, cookie: '' })]) expect((await alerts(m)).map((alert) => alert.kind)).not.toContain('re_enrolment_closed')
    const elsewhere = await owner()
    expect(await alerts(elsewhere)).toEqual([])
  })

  it('the session of a replaced passkey reaches no route', async () => {
    const o = await owner()
    const target = await colleague(o, 'viewer')
    await ceremony(o, { seatId: target.seatId })
    for (const route of routes.filter((r) => r.roles !== 'public')) {
      const refused = await call(route.method, route.path.replace(':id', target.key.id), { cookie: target.cookie })
      expect(refused.status, route.path).toBe(401)
    }
  })
})

// ---- milestone 3: roles, two-person approval, freeze, the 30 day rule, limits, the audit page ----
const seatOf = (seatId: string) => row<{ role: string; state: string }>('SELECT role, state FROM seats WHERE id = ?', seatId)
const approvalOf = (id: string) => row<{ state: string; checker_seat_id: string | null }>('SELECT state, checker_seat_id FROM approvals WHERE id = ?', id)
const lastAudit = (orgId: string) => row('SELECT action, actor_id, subject_id, detail FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1', orgId)
const alertsOf = async (m: Holder) => (await call('GET', '/api/me', { cookie: m.cookie })).body.alerts as Record<string, unknown>[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requestsOf = async (m: Holder) => (await call('GET', '/api/org', { cookie: m.cookie })).body.approvals as any[]
const OWNER_NAME = 'Owner of Northwind Vaults'
// An Owner, an Approver as the second person, and a Viewer to act on.
async function trio() {
  const o = await owner()
  return { o, a: await colleague(o, 'approver'), v: await colleague(o, 'viewer') }
}

describe('r. the role table', () => {
  const rule = (r: (typeof routes)[number]) =>
    [r.roles === 'public' ? 'public' : r.roles.join(','), r.fresh && 'fresh', r.twoKeys && 'twoKeys', r.settled && 'settled', r.second && `second:${r.second}`].filter(Boolean).join(' ')

  it('names every route: who may call it, the fresh passkey check, the two passkeys, the quarantine gate, the second person', () => {
    const any = 'owner,admin,trader,approver,compliance,viewer'
    const key = 'owner,admin,approver,compliance'
    const change = 'owner,admin fresh twoKeys settled'
    expect(Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, rule(r)]))).toEqual({
      'POST /api/enrol/start': 'public', 'POST /api/enrol/finish': 'public', 'POST /api/signin/start': 'public', 'POST /api/signin/finish': 'public',
      'POST /api/stop/start': 'public', 'POST /api/stop/finish': 'public',
      'GET /api/me': any, 'GET /api/org': any, 'POST /api/sessions/:id/revoke': any, 'POST /api/signout': any, 'POST /api/stepup/start': any, 'POST /api/stepup/finish': any,
      'POST /api/passkeys/start': `${any} fresh`, 'POST /api/passkeys/finish': `${any} fresh`, 'POST /api/passkeys/:id/revoke': `${any} fresh twoKeys`,
      'POST /api/tickets': 'owner,admin fresh twoKeys', 'POST /api/tickets/:id/confirm/start': `${key} twoKeys`, 'POST /api/tickets/:id/confirm': `${key} twoKeys`,
      'POST /api/tickets/:id/cancel': 'owner fresh twoKeys',
      'POST /api/members/:id/freeze': change, 'POST /api/members/:id/unfreeze': `${change} second:seat.unfreeze`,
      'POST /api/members/:id/role': `${change} second:seat.role`, 'POST /api/members/:id/remove': `${change} second:seat.remove`,
      'POST /api/policy': 'owner fresh twoKeys settled second:policy.synced_keys',
      'POST /api/approvals/:id/approve': `${key} fresh twoKeys settled`, 'POST /api/approvals/:id/reject': `${key} fresh twoKeys`, 'POST /api/approvals/:id/cancel': 'owner,admin',
      'GET /api/audit': 'owner,compliance,viewer', 'POST /api/audit/export': 'owner,compliance,viewer fresh',
    })
    // A route has its own handler, or it is a change for two people that the router files as a request: never both.
    for (const r of routes) expect(Boolean(r.handler) !== Boolean(r.second), r.path).toBe(true)
  })

  it('the router refuses a role that is not in the table, on every route', async () => {
    const o = await owner()
    const people: Record<string, Holder> = { owner: o }
    for (const role of ['admin', 'trader', 'approver', 'compliance', 'viewer']) people[role] = await colleague(o, role)
    // Sign-out last: it ends the session the other calls need.
    const gated = routes.filter((r) => r.roles !== 'public').sort((x, y) => Number(x.path === '/api/signout') - Number(y.path === '/api/signout'))
    expect(gated.length).toBe(routes.length - 6)
    for (const route of gated) {
      for (const [role, m] of Object.entries(people)) {
        const answer = await call(route.method, route.path.replace(':id', '0'.repeat(32)), { cookie: m.cookie })
        expect(answer.status === 403 && answer.body.error === 'forbidden', `${role} ${route.path}`).toBe(!(route.roles as string[]).includes(role))
      }
    }
  })

  it('"What each role can do" is that table: every signed-in route has a sentence, and the page gets its rows from the routes', async () => {
    const o = await owner()
    const gated = routes.filter((r) => r.roles !== 'public')
    for (const r of gated) expect(r.can, r.path).toMatch(/^[A-Z].{8,}/)
    const { rights } = (await call('GET', '/api/org', { cookie: o.cookie })).body
    expect(rights.map((x: { can: string }) => x.can)).toEqual([...new Set(gated.map((r) => r.can))])
    // Routes that share a sentence share its rule, or the page would say less than the router does.
    for (const r of gated) expect(rights.find((x: { can: string }) => x.can === r.can), r.path).toEqual({ can: r.can, roles: r.roles, fresh: Boolean(r.fresh), second: Boolean(r.second) })
  })

  it('a route that needs a second person changes nothing by itself: it files a request', async () => {
    const { o, v } = await trio()
    const frozen = await colleague(o, 'trader')
    expect((await act(o, frozen.seatId, 'freeze')).status).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Record<string, () => Promise<{ body: any }>> = {
      'seat.unfreeze': () => act(o, frozen.seatId, 'unfreeze'),
      'seat.role': () => act(o, v.seatId, 'role', { role: 'trader' }),
      'seat.remove': () => act(o, v.seatId, 'remove'),
      'policy.synced_keys': () => post('/api/policy', o, { syncedKeys: true }),
    }
    expect(Object.keys(calls).sort()).toEqual(routes.flatMap((r) => r.second ?? []).sort())
    const rest = TABLES.filter((table) => table !== 'approvals' && table !== 'audit_log')
    const before = await snapshot(rest)
    for (const [kind, run] of Object.entries(calls)) {
      const answer = await run()
      expect(answer.body, kind).toMatchObject({ state: 'requested' })
      expect(await row('SELECT action, state, requester_seat_id, checker_seat_id FROM approvals WHERE id = ?', answer.body.id), kind)
        .toEqual({ action: kind, state: 'pending', requester_seat_id: o.seatId, checker_seat_id: null })
    }
    expect(await snapshot(rest)).toBe(before)
  })
})

describe('s. two-person approval', () => {
  it('a request names the change, its target, the new value and its requester, waits 7 days, and is applied in the commit of its approval', async () => {
    const { o, a, v } = await trio()
    const trader = await colleague(o, 'trader')
    const asked = await act(o, v.seatId, 'role', { role: 'trader' })
    expect(asked.body).toEqual({ state: 'requested', id: expect.stringMatching(/^[0-9a-f]{32}$/), notBefore: null })
    const { id } = asked.body
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    expect(await row('SELECT action, subject_id, payload, requester_seat_id, checker_seat_id, state, expires_at FROM approvals WHERE id = ?', id))
      .toEqual({ action: 'seat.role', subject_id: v.seatId, payload: '{"value":"trader"}', requester_seat_id: o.seatId, checker_seat_id: null, state: 'pending', expires_at: now + 7 * DAY })
    expect(await lastAudit(o.orgId)).toEqual({ action: 'approval.request', actor_id: o.seatId, subject_id: id, detail: 'seat.role' })
    // Shown with names to its requester and to every key role; never to a Trader, nor to the Viewer it is about.
    const shown = { id, kind: 'seat.role', subjectId: v.seatId, name: 'A viewer', role: 'viewer', value: 'trader', requesterSeatId: o.seatId, requester: OWNER_NAME, requesterRole: 'owner', createdAt: now, expiresAt: now + 7 * DAY, notBefore: null }
    expect(await requestsOf(o)).toEqual([{ ...shown, mine: true }])
    expect(await requestsOf(a)).toEqual([{ ...shown, mine: false }])
    expect(await alertsOf(a)).toContainEqual({ key: `request:${id}`, kind: 'approval_waiting', name: OWNER_NAME })
    expect(await requestsOf(trader)).toEqual([])
    expect(await requestsOf(v)).toEqual([])
    // The same change is not asked for twice.
    expect((await act(o, v.seatId, 'role', { role: 'admin' })).body).toEqual({ error: 'already_requested' })
    const rows = await count('audit_log', o.orgId)
    expect((await decide(a, id, 'approve')).body).toEqual({ state: 'applied' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'trader', state: 'active' })
    expect(await row('SELECT state, checker_seat_id, decided_at FROM approvals WHERE id = ?', id)).toEqual({ state: 'applied', checker_seat_id: a.seatId, decided_at: now })
    expect(await count('audit_log', o.orgId)).toBe(rows + 1)
    expect(await lastAudit(o.orgId)).toEqual({ action: 'seat.role', actor_id: a.seatId, subject_id: v.seatId, detail: 'viewer.trader' })
    expect(await requestsOf(o)).toEqual([])
    // The member's sessions end, the new role starts at the next sign-in, and everyone but the approver is told.
    expect((await call('GET', '/api/me', { cookie: v.cookie })).status).toBe(401)
    const me = await call('GET', '/api/me', { cookie: (await again(v)).cookie })
    expect(me.body.seat.role).toBe('trader')
    expect(me.body.alerts).toContainEqual({ key: `change:${rows + 1}`, kind: 'changed', what: 'seat.role', detail: 'viewer.trader', at: now, name: 'A viewer', mine: true })
    expect((await alertsOf(o)).map((x) => x.kind)).toContain('changed')
    expect((await alertsOf(a)).map((x) => x.kind)).not.toContain('changed')
  })

  it('the maker is never the checker: refused by the code, and by the database', async () => {
    const { o, a, v } = await trio()
    const { id } = (await act(o, v.seatId, 'role', { role: 'trader' })).body
    const before = await snapshot()
    for (const what of ['approve', 'reject'] as const) {
      const own = await decide(o, id, what)
      expect([own.status, own.body], what).toEqual([403, { error: 'own_request' }])
    }
    expect(await snapshot()).toBe(before)
    // The same rule is in the schema: a row whose checker is its requester cannot be written.
    await expect(db.prepare(`UPDATE approvals SET state = 'applied', checker_seat_id = requester_seat_id WHERE id = ?`).bind(id).run()).rejects.toThrow(/CHECK/)
    expect((await decide(a, id, 'approve')).status).toBe(200)
  })

  it('the second person passes a fresh passkey check and holds two passkeys; a seat in quarantine neither freezes, asks nor approves', async () => {
    const { o, a, v } = await trio()
    const { id } = (await act(o, v.seatId, 'role', { role: 'trader' })).body
    now += 5 * MIN + 1
    for (const what of ['approve', 'reject'] as const) expect((await decide(a, id, what)).body, what).toEqual({ error: 'step_up_required' })
    await stepUp(a, a.key)
    await stepUp(o, o.key)
    const quarantine = (seatId: string, until: number | null) => db.prepare('UPDATE seats SET quarantine_until = ? WHERE id = ?').bind(until, seatId).run()
    await quarantine(a.seatId, now + HOUR)
    expect((await decide(a, id, 'approve')).body).toEqual({ error: 'quarantine' })
    await quarantine(o.seatId, now + HOUR)
    for (const what of ['freeze', 'unfreeze', 'role', 'remove'] as const) expect((await act(o, v.seatId, what, { role: 'admin' })).body, what).toEqual({ error: 'quarantine' })
    expect((await post('/api/policy', o, { syncedKeys: true })).body).toEqual({ error: 'quarantine' })
    await quarantine(a.seatId, null)
    expect((await post(`/api/passkeys/${a.key2.id}/revoke`, a)).status).toBe(200)
    expect((await decide(a, id, 'approve')).body).toEqual({ error: 'second_key_required' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    expect(await approvalOf(id)).toEqual({ state: 'pending', checker_seat_id: null })
  })

  it('two approvers at the same instant: the change is applied once', async () => {
    const { o, a, v } = await trio()
    const other = await colleague(o, 'compliance')
    const { id } = (await act(o, v.seatId, 'role', { role: 'trader' })).body
    const late = await call('POST', `/api/approvals/${id}/approve`, { cookie: a.cookie, env: racing(() => decide(other, id, 'approve')) })
    expect(late.status).toBe(404)
    expect(await approvalOf(id)).toEqual({ state: 'applied', checker_seat_id: other.seatId })
    expect((await row<{ n: number }>(`SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'seat.role'`, o.orgId))!.n).toBe(1)
    expect(await seatOf(v.seatId)).toEqual({ role: 'trader', state: 'active' })
  })

  it('a request that was cancelled, rejected or is 7 days old cannot be approved; only its requester cancels it', async () => {
    const { o, a, v } = await trio()
    const admin = await colleague(o, 'admin')
    const ask = async (role: string) => (await act(o, v.seatId, 'role', { role })).body.id as string
    let id = await ask('trader')
    expect((await decide(admin, id, 'cancel')).status).toBe(404)
    expect((await decide(o, id, 'cancel')).body).toEqual({ ok: true })
    expect(await approvalOf(id)).toEqual({ state: 'cancelled', checker_seat_id: null })
    expect(await lastAudit(o.orgId)).toEqual({ action: 'approval.cancel', actor_id: o.seatId, subject_id: id, detail: 'seat.role' })
    expect((await decide(a, id, 'approve')).status).toBe(404)
    id = await ask('trader')
    expect((await decide(a, id, 'reject')).body).toEqual({ ok: true })
    expect(await approvalOf(id)).toEqual({ state: 'rejected', checker_seat_id: a.seatId })
    expect(await lastAudit(o.orgId)).toEqual({ action: 'approval.reject', actor_id: a.seatId, subject_id: id, detail: 'seat.role' })
    expect((await decide(a, id, 'approve')).status).toBe(404)
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    // Alive in its last millisecond, dead at the 7 days.
    id = await ask('trader')
    now += 7 * DAY - 1
    expect((await decide(await again(a), id, 'approve')).status).toBe(200)
    id = await ask2()
    now += 7 * DAY
    expect(await requestsOf(await again(a))).toEqual([])
    expect((await decide(a, id, 'approve')).status).toBe(404)
    expect((await decide(await again(o), id, 'cancel')).status).toBe(404)
    expect(await seatOf(v.seatId)).toEqual({ role: 'trader', state: 'active' })
    async function ask2() {
      await again(o)
      return ask('viewer')
    }
  })

  it('a role change never goes above the requester\'s own role, and is judged again when it is approved', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const a = await colleague(o, 'approver')
    const v = await colleague(o, 'viewer')
    const w = await colleague(o, 'viewer')
    expect((await act(admin, v.seatId, 'role', { role: 'owner' })).body).toEqual({ error: 'forbidden' })
    expect((await act(admin, o.seatId, 'role', { role: 'admin' })).body).toEqual({ error: 'forbidden' }) // an Admin does not act on an Owner
    for (const role of ['viewer', 'root', undefined]) expect((await act(admin, v.seatId, 'role', { role })).body, String(role)).toEqual({ error: 'invalid' })
    expect(await count('approvals', o.orgId)).toBe(0)
    // Up to its own role, yes.
    const up = await act(admin, v.seatId, 'role', { role: 'admin' })
    const other = await act(admin, w.seatId, 'role', { role: 'trader' })
    expect([up.status, other.status]).toEqual([200, 200])
    // The Viewer is frozen before the approval: the change is judged again and no longer applies.
    expect((await act(o, v.seatId, 'freeze')).status).toBe(200)
    expect((await decide(a, up.body.id, 'approve')).body).toEqual({ error: 'invalid' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'frozen' })
    expect(await approvalOf(up.body.id)).toEqual({ state: 'pending', checker_seat_id: null })
    // The Admin is lowered: what it had asked for goes with its role.
    const down = await act(o, admin.seatId, 'role', { role: 'viewer' })
    expect((await decide(a, down.body.id, 'approve')).status).toBe(200)
    expect([(await approvalOf(up.body.id))!.state, (await approvalOf(other.body.id))!.state]).toEqual(['cancelled', 'cancelled'])
    expect((await decide(a, other.body.id, 'approve')).status).toBe(404)
    expect(await seatOf(w.seatId)).toEqual({ role: 'viewer', state: 'active' })
  })

  it('the last Owner is never frozen, lowered or removed: when it is asked, and again when it is approved', async () => {
    const o = await owner()
    const a = await colleague(o, 'approver')
    for (const [what, body] of [['freeze', {}], ['remove', {}], ['role', { role: 'admin' }]] as const) expect((await act(o, o.seatId, what, body)).body, what).toEqual({ error: 'last_owner' })
    expect(await count('approvals', o.orgId)).toBe(0)
    expect(await seatOf(o.seatId)).toEqual({ role: 'owner', state: 'active' })
    // With a second Owner one of the two may step down.
    const second = await colleague(o, 'owner')
    const lower = await act(o, o.seatId, 'role', { role: 'admin' })
    const leave = await act(second, o.seatId, 'remove')
    expect([lower.status, leave.status]).toEqual([200, 200])
    // The second Owner freezes its own seat: the first is the last again, and neither request applies any more.
    expect((await act(second, second.seatId, 'freeze')).status).toBe(200)
    expect((await approvalOf(leave.body.id))!.state).toBe('cancelled')
    expect((await decide(a, lower.body.id, 'approve')).body).toEqual({ error: 'last_owner' })
    expect(await seatOf(o.seatId)).toEqual({ role: 'owner', state: 'active' })
    expect((await act(o, o.seatId, 'freeze')).body).toEqual({ error: 'last_owner' })
  })

  it('removing a member takes two people; an invited seat that never enrolled, one', async () => {
    const { o, a, v } = await trio()
    const invited = await issue(o, { displayName: 'Never Came', role: 'admin' })
    const reEnrol = await issue(o, { seatId: v.seatId })
    const other = await act(o, v.seatId, 'role', { role: 'trader' })
    const asked = await act(o, v.seatId, 'remove')
    expect(asked.body).toMatchObject({ state: 'requested' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    expect((await decide(a, asked.body.id, 'approve')).body).toEqual({ state: 'applied' })
    expect(await lastAudit(o.orgId)).toEqual({ action: 'seat.remove', actor_id: a.seatId, subject_id: v.seatId, detail: null })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'removed' })
    expect([await credentialState(v.key), await credentialState(v.key2)]).toEqual(['revoked', 'revoked'])
    expect((await call('GET', '/api/me', { cookie: v.cookie })).status).toBe(401)
    expect((await signIn(v.key)).status).toBe(401)
    expect((await call('GET', '/api/org', { cookie: o.cookie })).body.sessions.filter((session: { seatId: string }) => session.seatId === v.seatId)).toEqual([])
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', reEnrol.body.ticketId)).toEqual({ state: 'dead' })
    expect((await approvalOf(other.body.id))!.state).toBe('cancelled') // the other request about this seat
    expect((await act(o, v.seatId, 'remove')).status).toBe(404)
    // The invited seat: no passkey was ever confirmed on it, so one person is enough.
    expect((await act(o, invited.body.seatId, 'remove')).body).toEqual({ state: 'applied' })
    expect(await lastAudit(o.orgId)).toEqual({ action: 'seat.remove', actor_id: o.seatId, subject_id: invited.body.seatId, detail: 'invited' })
    expect(await seatOf(invited.body.seatId)).toEqual({ role: 'admin', state: 'removed' })
    expect((await call('POST', '/api/enrol/start', { body: { ticket: invited.body.link.split('#/enrol/')[1] } })).status).toBe(404)
  })

  it('the passkey rule for key roles: tightening applies at its approval, relaxing can be approved only 24 hours after it was asked', async () => {
    const o = await owner()
    const a = await colleague(o, 'approver')
    const synced = async () => (await row<{ n: number }>('SELECT synced_keys_allowed AS n FROM organisations WHERE id = ?', o.orgId))!.n
    for (const body of [{ syncedKeys: false }, {}, { syncedKeys: 'yes' }]) expect((await post('/api/policy', o, body)).body).toEqual({ error: 'invalid' })
    const relax = await post('/api/policy', o, { syncedKeys: true })
    expect(relax.body).toEqual({ state: 'requested', id: expect.any(String), notBefore: now + DAY })
    expect((await decide(a, relax.body.id, 'approve')).body).toEqual({ error: 'too_early' })
    now += DAY - 1
    expect((await decide(await again(a), relax.body.id, 'approve')).body).toEqual({ error: 'too_early' })
    expect(await synced()).toBe(0)
    now += 1
    expect((await decide(a, relax.body.id, 'approve')).body).toEqual({ state: 'applied' })
    expect(await synced()).toBe(1)
    expect(await lastAudit(o.orgId)).toEqual({ action: 'policy.synced_keys', actor_id: a.seatId, subject_id: o.orgId, detail: 'synced' })
    const tighten = await post('/api/policy', await again(o), { syncedKeys: false })
    expect(tighten.body.notBefore).toBeNull()
    expect((await decide(a, tighten.body.id, 'approve')).status).toBe(200)
    expect(await synced()).toBe(0)
  })

  it('a role that needs hardware keys is not given to a seat that holds a synced passkey', async () => {
    const { o, v } = await trio()
    expect((await addKey(v, { backupEligible: true })).status).toBe(200)
    expect((await act(o, v.seatId, 'role', { role: 'approver' })).body).toEqual({ error: 'device_bound_required' })
    expect((await act(o, v.seatId, 'role', { role: 'trader' })).status).toBe(200)
  })

  it('a role that changes at the same instant: the write is judged with the role of that moment, not the session\'s', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const a = await colleague(o, 'approver')
    const c = await colleague(o, 'compliance')
    const second = await colleague(o, 'owner')
    const v = await colleague(o, 'viewer')
    // The Admin is lowered at the instant it freezes a colleague.
    const lower = (await act(o, admin.seatId, 'role', { role: 'viewer' })).body.id
    const late = await call('POST', `/api/members/${v.seatId}/freeze`, { cookie: admin.cookie, env: racing(() => decide(a, lower, 'approve')) })
    expect(late.body).toEqual({ error: 'forbidden' })
    expect(await seatOf(admin.seatId)).toEqual({ role: 'viewer', state: 'active' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    // The Approver is frozen at the instant it approves.
    const ask = (await act(o, v.seatId, 'role', { role: 'trader' })).body.id
    const stale = await call('POST', `/api/approvals/${ask}/approve`, { cookie: a.cookie, env: racing(() => act(o, a.seatId, 'freeze')) })
    expect(stale.body).toEqual({ error: 'forbidden' })
    expect(await seatOf(a.seatId)).toEqual({ role: 'approver', state: 'frozen' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    // The second Owner is lowered at the instant it asks to relax the passkey rule.
    const down = (await act(o, second.seatId, 'role', { role: 'admin' })).body.id
    const policy = await call('POST', '/api/policy', { cookie: second.cookie, body: { syncedKeys: true }, env: racing(() => decide(c, down, 'approve')) })
    expect(policy.body).toEqual({ error: 'forbidden' })
    expect(await row(`SELECT count(*) AS n FROM approvals WHERE org_id = ? AND action = 'policy.synced_keys'`, o.orgId)).toEqual({ n: 0 })
  })

  it('the confirmation of a new passkey is not decided through these routes', async () => {
    const o = await owner()
    const a = await colleague(o, 'approver')
    expect((await ceremony(o, { displayName: 'New Admin', role: 'admin' })).state).toBe('second')
    const { id } = (await row<{ id: string }>(`SELECT id FROM approvals WHERE org_id = ? AND action = 'ticket.confirm'`, o.orgId))!
    for (const what of ['approve', 'reject'] as const) expect((await decide(a, id, what)).status, what).toBe(404)
    expect((await decide(o, id, 'cancel')).status).toBe(404)
    expect(await approvalOf(id)).toEqual({ state: 'pending', checker_seat_id: null })
    expect(await requestsOf(a)).toEqual([])
  })
})

describe('t. freezing a seat: one person in an emergency, two to undo it', () => {
  it('an Owner freezes any seat, an Admin a seat at or below its role: passkeys suspended, sessions ended, what the seat had open closed, every member told', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    const a = await colleague(o, 'approver')
    const v = await colleague(o, 'viewer')
    expect((await act(admin, o.seatId, 'freeze')).body).toEqual({ error: 'forbidden' })
    expect((await act(admin, v.seatId, 'freeze')).body).toEqual({ state: 'applied' })
    expect(await lastAudit(o.orgId)).toEqual({ action: 'seat.freeze', actor_id: admin.seatId, subject_id: v.seatId, detail: null })
    // The Admin has things open: a link it issued, and a request.
    const ticket = await issue(admin, { displayName: 'Ada Viewer', role: 'viewer' })
    const asked = await act(admin, v.seatId, 'unfreeze')
    expect([ticket.status, asked.status]).toEqual([200, 200])
    now += MIN
    expect((await act(o, admin.seatId, 'freeze')).body).toEqual({ state: 'applied' })
    expect(await seatOf(admin.seatId)).toEqual({ role: 'admin', state: 'frozen' })
    expect([await credentialState(admin.key), await credentialState(admin.key2)]).toEqual(['suspended', 'suspended'])
    expect((await call('GET', '/api/me', { cookie: admin.cookie })).status).toBe(401)
    const view = (await call('GET', '/api/org', { cookie: o.cookie })).body
    expect(view.sessions.filter((session: { seatId: string }) => [admin.seatId, v.seatId].includes(session.seatId))).toEqual([])
    expect(view.frozen).toHaveLength(2)
    expect(view.frozen).toEqual(expect.arrayContaining([{ id: admin.seatId, name: 'A admin', by: OWNER_NAME, at: now, stopped: false }, { id: v.seatId, name: 'A viewer', by: 'A admin', at: now - MIN, stopped: false }]))
    expect(await row('SELECT state FROM enrolment_tickets WHERE id = ?', ticket.body.ticketId)).toEqual({ state: 'dead' })
    expect((await approvalOf(asked.body.id))!.state).toBe('cancelled')
    // Every member is told who froze which seat, and when.
    for (const m of [o, a]) {
      expect(await alertsOf(m)).toContainEqual({ key: `frozen:${admin.seatId}:${now}`, kind: 'seat_frozen', name: 'A admin', by: OWNER_NAME, at: now, stopped: false })
      expect(await alertsOf(m)).toContainEqual({ key: `frozen:${v.seatId}:${now - MIN}`, kind: 'seat_frozen', name: 'A viewer', by: 'A admin', at: now - MIN, stopped: false })
    }
    // A frozen seat is not frozen again, and gets no enrolment link.
    expect((await act(o, admin.seatId, 'freeze')).status).toBe(404)
    expect((await issue(o, { seatId: admin.seatId })).status).toBe(404)
  })

  it('a frozen member reaches no route: the sign-in says who froze the seat and when, and opens no session', async () => {
    const { o, v } = await trio()
    now += MIN
    expect((await act(o, v.seatId, 'freeze')).status).toBe(200)
    for (const route of routes.filter((r) => r.roles !== 'public')) expect((await call(route.method, route.path.replace(':id', v.seatId), { cookie: v.cookie })).status, route.path).toBe(401)
    const before = await snapshot()
    for (const key of [v.key, v.key2]) {
      const told = await signIn(key)
      expect([told.status, told.body, told.cookie]).toEqual([403, { error: 'seat_frozen', by: OWNER_NAME, at: now, stopped: false }, ''])
    }
    // Only a passkey of that seat, after its check, is told anything; and it stops nothing.
    expect((await signIn(v.key, { userVerified: false })).body).toEqual({ error: 'sign_in_failed' })
    expect((await stop(v.key)).status).toBe(401)
    expect(await snapshot()).toBe(before)
  })

  it('unfreezing takes two people, and the passkeys that were active before the freeze stand', async () => {
    const { o, a, v } = await trio()
    expect((await act(o, v.seatId, 'unfreeze')).status).toBe(404) // an active seat
    await act(o, v.seatId, 'freeze')
    const asked = await act(o, v.seatId, 'unfreeze')
    expect(asked.body).toMatchObject({ state: 'requested' })
    expect((await signIn(v.key)).status).toBe(403)
    expect((await decide(o, asked.body.id, 'approve')).status).toBe(403)
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'frozen' })
    expect((await decide(a, asked.body.id, 'approve')).body).toEqual({ state: 'applied' })
    expect(await seatOf(v.seatId)).toEqual({ role: 'viewer', state: 'active' })
    expect([await credentialState(v.key), await credentialState(v.key2)]).toEqual(['active', 'active'])
    // The session from before the freeze does not come back with the passkeys.
    expect((await call('GET', '/api/me', { cookie: v.cookie })).status).toBe(401)
    expect((await signIn(v.key)).status).toBe(200)
  })

  it('a passkey added by a contested re-enrolment stays revoked after the unfreeze; a passkey replaced without a stop stays suspended', async () => {
    const { o, a, v } = await trio()
    const unfreeze = async () => expect((await decide(a, (await act(o, v.seatId, 'unfreeze')).body.id, 'approve')).status).toBe(200)
    // Contested: the member's old passkey stops the replacement, which freezes the seat.
    const contested = await ceremony(o, { seatId: v.seatId })
    expect((await stop(v.key)).status).toBe(200)
    expect((await signIn(v.key)).body).toEqual({ error: 'seat_frozen', by: 'A viewer', at: now, stopped: true })
    await unfreeze()
    expect([await credentialState(v.key), await credentialState(v.key2), await credentialState(contested.key)]).toEqual(['active', 'active', 'revoked'])
    expect((await signIn(v.key)).status).toBe(200)
    expect((await signIn(contested.key)).status).toBe(401)
    // Not contested: re-enrolled again, then frozen by the Owner during quarantine. The new passkey was the active one.
    const accepted = await ceremony(o, { seatId: v.seatId })
    expect((await act(o, v.seatId, 'freeze')).status).toBe(200)
    expect([await credentialState(v.key), await credentialState(accepted.key)]).toEqual(['suspended', 'suspended'])
    expect((await stop(v.key)).status).toBe(401)
    expect((await signIn(v.key)).status).toBe(401)
    await unfreeze()
    expect([await credentialState(v.key), await credentialState(v.key2), await credentialState(accepted.key)]).toEqual(['suspended', 'suspended', 'active'])
    expect((await signIn(accepted.key)).status).toBe(200)
    expect((await signIn(v.key)).body).toMatchObject({ error: 'passkey_replaced' })
  })

  it('two re-enrolments inside one quarantine: a stop restores the stopping passkey and the ones replaced before it, and revokes what came after', async () => {
    const o = await owner()
    for (const stopper of ['first', 'second'] as const) {
      const v = await colleague(o, 'viewer')
      const second = await ceremony(o, { seatId: v.seatId })
      now += MIN
      const third = await ceremony(o, { seatId: v.seatId })
      expect((await stop(stopper === 'first' ? v.key : second.key)).status).toBe(200)
      expect([await credentialState(v.key), await credentialState(v.key2), await credentialState(second.key), await credentialState(third.key)], stopper)
        .toEqual(['active', 'active', stopper === 'first' ? 'revoked' : 'active', 'revoked'])
    }
  })
})

describe('u. the 72 hour wait replaces the second person only where no other key-role seat was held in the last 30 days', () => {
  const invite = async (o: Holder & { key: Key }, name: string) => ceremony(o, { displayName: name, role: 'admin' })

  it('a one-person organisation: allowed', async () => {
    const o = await owner()
    await colleague(o, 'viewer')
    await colleague(o, 'trader')
    // A seat nobody enrolled on is no person, and neither is one that was removed before anyone did.
    await issue(o, { displayName: 'Invited Approver', role: 'approver' })
    expect((await act(o, (await issue(o, { displayName: 'Invited Compliance', role: 'compliance' })).body.seatId, 'remove')).body).toEqual({ state: 'applied' })
    expect((await invite(o, 'New Admin')).state).toBe('wait')
  })

  it('a second key-role seat that is active or frozen: refused, and one Owner who freezes every colleague gains nothing', async () => {
    const o = await owner()
    const b = await colleague(o, 'compliance')
    expect((await invite(o, 'New Admin')).state).toBe('second')
    expect((await act(o, b.seatId, 'freeze')).status).toBe(200)
    const alone = await invite(o, 'Other Admin')
    expect(alone.state).toBe('second')
    expect(await row('SELECT not_before FROM approvals WHERE subject_id = ?', alone.ticketId)).toEqual({ not_before: null })
    now += 72 * HOUR + 1
    expect((await signIn(alone.key)).status).toBe(401)
    expect(await credentialState(alone.key)).toBe('pending')
  })

  it('a key-role seat removed 10 days ago: refused; 31 days ago: allowed', async () => {
    const o = await owner()
    const b = await colleague(o, 'admin')
    const leave = await act(o, b.seatId, 'remove')
    expect((await decide(b, leave.body.id, 'approve')).status).toBe(200) // the member agrees: that is the second person
    expect(await seatOf(b.seatId)).toEqual({ role: 'admin', state: 'removed' })
    now += 10 * DAY
    expect((await invite(await again(o), 'Admin 10')).state).toBe('second')
    now += 20 * DAY - 1
    expect((await invite(await again(o), 'Admin 30')).state).toBe('second')
    now += DAY + 1
    expect((await invite(await again(o), 'Admin 31')).state).toBe('wait')
  })

  it('a seat that held a key role in the last 30 days counts, and so does the key-role member who is re-enrolled', async () => {
    const o = await owner()
    const b = await colleague(o, 'admin')
    // Two key-role members, one of them lost every passkey: the other cannot bring the seat back alone after a wait.
    expect((await ceremony(o, { seatId: b.seatId })).state).toBe('second')
    const lower = await act(o, b.seatId, 'role', { role: 'viewer' })
    expect((await decide(b, lower.body.id, 'approve')).status).toBe(200)
    expect((await invite(o, 'Admin 0')).state).toBe('second')
    now += 30 * DAY
    expect((await invite(await again(o), 'Admin 30')).state).toBe('wait')
  })
})

describe('v. limits asked for by the review of milestone 2', () => {
  it('ten new invited seats per issuer in 24 hours', async () => {
    const o = await owner()
    const admin = await colleague(o, 'admin')
    now += DAY // the helper wrote the Admin's seat as invited by the Owner: that day is over
    await again(admin)
    await again(o)
    for (let i = 0; i < 9; i++) expect((await issue(o, { displayName: `Viewer ${i}`, role: 'viewer' })).status).toBe(200)
    // A new link for a seat that exists is not a new seat: before the limit and after it.
    const first = await row<{ id: string }>(`SELECT id FROM seats WHERE org_id = ? AND display_name = 'Viewer 0'`, o.orgId)
    expect((await issue(o, { seatId: first!.id })).status).toBe(200)
    expect((await issue(o, { displayName: 'Viewer 9', role: 'viewer' })).status).toBe(200)
    const more = await issue(o, { displayName: 'Viewer 10', role: 'viewer' })
    expect([more.status, more.body]).toEqual([429, { error: 'seat_limit' }])
    expect(await count('seats', o.orgId)).toBe(12)
    expect((await issue(o, { seatId: first!.id })).status).toBe(200)
    // Another issuer has its own ten; the day passes.
    expect((await issue(admin, { displayName: 'Viewer 10', role: 'viewer' })).status).toBe(200)
    now += DAY - 1
    expect((await issue(await again(o), { displayName: 'Viewer 11', role: 'viewer' })).status).toBe(429)
    now += 1
    expect((await issue(o, { displayName: 'Viewer 11', role: 'viewer' })).status).toBe(200)
  })

  it('a ticket that was never confirmed is deleted with its pending passkey when a ticket is next written, 12 days after it was made', async () => {
    const o = await owner()
    const confirmed = await ceremony(o, { displayName: 'Ada Viewer', role: 'viewer' })
    const dead = await issue(o, { displayName: 'Bea Viewer', role: 'viewer' })
    const stored = await enrolLink(dead.body.link)
    const unused = await issue(o, { displayName: 'Cal Viewer', role: 'viewer' })
    const tickets = async () => (await db.prepare('SELECT id FROM enrolment_tickets WHERE org_id = ?').bind(o.orgId).all<{ id: string }>()).results.map((t) => t.id)
    now += 12 * DAY
    const atTwelve = await issue(await again(o), { displayName: 'Dan Viewer', role: 'viewer' })
    expect(await tickets()).toHaveLength(5)
    expect(await credentialState(stored.key)).toBe('pending')
    now += 1
    const later = await issue(o, { displayName: 'Eve Viewer', role: 'viewer' })
    expect(await credentialState(stored.key)).toBeUndefined()
    const left = await tickets()
    expect(left).toHaveLength(4)
    expect(left).toEqual(expect.arrayContaining([confirmed.ticketId, atTwelve.body.ticketId, later.body.ticketId]))
    expect(left).not.toContain(dead.body.ticketId)
    expect(left).not.toContain(unused.body.ticketId)
    expect(await credentialState(confirmed.key)).toBe('active')
    expect(await data.verifyAudit(db, o.orgId)).toMatchObject({ ok: true })
  })

  it('two passkeys of one seat cannot carry the same label; a revoked passkey gives its label back', async () => {
    const o = await owner()
    const add = async (label: string) => {
      const key = await softwareAuthenticator(SITE)
      const start = await post('/api/passkeys/start', o)
      return { key, ...(await post('/api/passkeys/finish', o, { label, response: await key.register(start.body.options) })) }
    }
    const third = await add('Desk drawer')
    expect(third.status).toBe(200)
    const twin = await add('Desk drawer')
    expect([twin.status, twin.body]).toEqual([409, { error: 'label_taken' }])
    expect(await credentialState(twin.key)).toBeUndefined()
    // The same on an enrolment link: the new passkey of a re-enrolled seat is told apart from the ones it replaces.
    const v = await colleague(o, 'viewer')
    const { label } = (await row<{ label: string }>('SELECT label FROM credentials WHERE id = ?', v.key.id))!
    const ticket = (await issue(o, { seatId: v.seatId })).body.link.split('#/enrol/')[1]
    const key = await softwareAuthenticator(SITE)
    const start = await call('POST', '/api/enrol/start', { body: { ticket } })
    const same = await call('POST', '/api/enrol/finish', { body: { ticket, label, response: await key.register(start.body.options) } })
    expect([same.status, same.body]).toEqual([409, { error: 'label_taken' }])
    expect((await enrol(ticket, key)).status).toBe(200) // the link is still good, with another label
    expect((await post(`/api/passkeys/${third.key.id}/revoke`, o)).status).toBe(200)
    expect((await add('Desk drawer')).status).toBe(200)
    // The rule is an index of the database (migrations/0002_labels.sql).
    await expect(db.prepare(`UPDATE credentials SET label = 'Desk drawer' WHERE id = ?`).bind(o.key2.id).run()).rejects.toThrow(/UNIQUE/)
  })
})

describe('w. the audit log page and its export', () => {
  // A role change asked by the Owner and approved by the Compliance officer.
  async function story() {
    const o = await owner()
    const c = await colleague(o, 'compliance')
    const v = await colleague(o, 'viewer')
    await decide(c, (await act(o, v.seatId, 'role', { role: 'trader' })).body.id, 'approve')
    return { o, c, v }
  }
  const stored = async (orgId: string) => (await db.prepare('SELECT seq, at, prev_hash AS prevHash, hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC').bind(orgId).all<{ seq: number; at: number; prevHash: string; hash: string }>()).results

  it('shows the rows of the organisation in plain words, newest first, with both hashes, and a chain state computed by the server', async () => {
    const { o, c } = await story()
    const rows = await stored(o.orgId)
    const page = await call('GET', '/api/audit', { cookie: c.cookie })
    expect(page.body.rows.map((r: { seq: number; at: number; prevHash: string; hash: string }) => ({ seq: r.seq, at: r.at, prevHash: r.prevHash, hash: r.hash }))).toEqual(rows)
    expect(page.body.rows[0]).toEqual({ ...rows[0], who: 'A compliance', event: 'Role changed: Viewer to Trader', target: 'A viewer' })
    expect(page.body.rows[1]).toMatchObject({ who: OWNER_NAME, event: 'Change requested: change a role', target: 'A viewer' })
    expect(page.body.rows.at(-1)).toMatchObject({ seq: 1, who: 'System', event: 'Organisation created', prevHash: '0'.repeat(64) })
    // Words, never codes.
    for (const r of page.body.rows) expect(r.event).toMatch(/^[A-Z][A-Za-z0-9 ,:;'-]+$/)
    expect(JSON.stringify(page.body)).not.toMatch(/Unlisted|session\.create|seat\.role|approval\.request/)
    expect(page.body.chain).toEqual({ ok: true, rows: rows.length, head: rows[0].hash })
    expect(page.body.next).toBeNull()
    // Someone with SQL access changes a row: the page says the chain is broken, and where.
    await db.prepare('DROP TRIGGER audit_log_no_update').run()
    await db.prepare(`UPDATE audit_log SET detail = 'viewer.owner' WHERE org_id = ? AND seq = ?`).bind(o.orgId, rows.length).run()
    expect((await call('GET', '/api/audit', { cookie: c.cookie })).body.chain).toEqual({ ok: false, seq: rows.length })
    await db.prepare(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`).run()
  })

  it('pages of 50, newest first', async () => {
    const o = await owner()
    for (let i = 0; i < 60; i++) await stepUp(o, o.key)
    const total = await count('audit_log', o.orgId)
    const first = await call('GET', '/api/audit', { cookie: o.cookie })
    expect(first.body.rows.map((r: { seq: number }) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => total - i))
    expect(first.body.next).toBe(total - 49)
    const second = await call('GET', `/api/audit?before=${first.body.next}`, { cookie: o.cookie })
    expect(second.body.rows.map((r: { seq: number }) => r.seq)).toEqual(Array.from({ length: total - 50 }, (_, i) => total - 50 - i))
    expect(second.body.next).toBeNull()
    expect(second.body.chain).toMatchObject({ ok: true, rows: total })
    for (const bad of ['0', '-1', 'x', '1.5', '1e3', '']) expect((await call('GET', `/api/audit?before=${bad}`, { cookie: o.cookie })).body.rows[0].seq, bad).toBe(total)
  })

  it('every action the data module writes has its words in the one table', () => {
    const written = [...new Set([...dataSource.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)].map((match) => match[1]))]
    expect(written.length).toBeGreaterThan(20)
    for (const action of written) expect(EVENTS[action], action).toEqual(expect.any(String))
  })

  it('the export: a fresh passkey check, one audit row, every row with both hashes, cells no spreadsheet will run, never cached', async () => {
    const { o, c, v } = await story()
    const rename = (seatId: string, name: string) => db.prepare('UPDATE seats SET display_name = ? WHERE id = ?').bind(name, seatId).run()
    await rename(v.seatId, '=HYPERLINK("http://evil.example","x")')
    await rename(o.seatId, '-2+3')
    now += 5 * MIN + 1
    expect((await post('/api/audit/export', c)).body).toEqual({ error: 'step_up_required' })
    await stepUp(c, c.key)
    const rows = await count('audit_log', o.orgId)
    const out = await post('/api/audit/export', c)
    expect(out.status).toBe(200)
    expect(out.headers.get('cache-control')).toBe('no-store')
    expect(out.body.name).toBe('ophis-audit-log-2026-11-10.csv')
    expect(await count('audit_log', o.orgId)).toBe(rows + 1)
    expect(await lastAudit(o.orgId)).toEqual({ action: 'audit.export', actor_id: c.seatId, subject_id: null, detail: null })
    const lines = out.body.csv.trim().split('\r\n')
    expect(lines[0]).toBe('"No.","Time (UTC)","Who","Event","Target","Previous row hash","Row hash"')
    expect(lines).toHaveLength(rows + 2) // the heading, every row, and the row of this export
    expect(lines.at(-1)).toMatch(new RegExp(`^"${rows + 1}","2026-11-10 09:05:00Z","A compliance","Audit log exported","","[0-9a-f]{64}","[0-9a-f]{64}"$`))
    for (const r of await stored(o.orgId)) expect(out.body.csv).toContain(`"${r.prevHash}","${r.hash}"`)
    expect(out.body.csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`)
    expect(out.body.csv).toContain(`"'-2+3"`)
    expect(out.body.csv).not.toMatch(/(^|,)"[=+\-@\t]/m)
    expect(['=1', '+1', '-1', '@a', '\ta', '\ra', 'a=1', 'say "hi"', 7, null].map(csvCell)).toEqual([`"'=1"`, `"'+1"`, `"'-1"`, `"'@a"`, `"'\ta"`, `"'\ra"`, '"a=1"', '"say ""hi"""', '"7"', '""'])
    // No file leaves without its audit row.
    await withTrigger('INSERT ON audit_log', async () => expect((await post('/api/audit/export', c)).body).toEqual({ error: 'internal' }))
  })
})
