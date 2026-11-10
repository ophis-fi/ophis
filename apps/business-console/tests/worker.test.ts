// Security invariants of milestone 1. Each test here was seen to fail once with its control removed
// (the list of mutations is in ARCHITECTURE.md). Runs in the Workers runtime against a local D1.
import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pageHeaders from '../public/_headers?raw'
import * as data from '../src/server/data.ts'
import { handle, routes, type Env } from '../src/server/index.ts'
import { userHandle } from '../src/server/passkeys.ts'
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
async function enrol(ticket: string, key: Key, answer: Answer = {}, cookie?: string) {
  const start = await call('POST', '/api/enrol/start', { body: { ticket }, cookie })
  if (start.status !== 200) return start
  return call('POST', '/api/enrol/finish', { body: { ticket, label: 'Office key 1', response: await key.register(start.body.options, answer) }, cookie })
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
    expect(stored.body).toEqual({ state: 'pending' })
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
    expect((await signIn(m.key)).status).toBe(401)
    await db.prepare(`UPDATE seats SET state = 'active' WHERE id = ?`).bind(m.seatId).run()
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
    const viewer = await invite(org.orgId, org.seatId, 'viewer')
    expect((await enrol(viewer.ticket, synced)).status).toBe(200)
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
    expect((await call('POST', `/api/sessions/${m.sessionId}/revoke`, { cookie: m.cookie })).status).toBe(200)
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
    const org = await call('GET', '/api/org', { cookie: m.cookie })
    expect(org.body.sessions.map((s: { id: string }) => s.id)).toEqual([m.sessionId])
    expect(org.body.currentSessionId).toBe(m.sessionId)
    expect(org.body.members).toHaveLength(1)
    expect(org.body.passkeys).toEqual([expect.objectContaining({ label: 'Office key 1', state: 'active', deviceBound: true })])
  })
})

describe('d. request checks', () => {
  for (const site of ['same-site', 'cross-site', 'none', null]) {
    it(`refuses an API call with Sec-Fetch-Site ${site ?? 'missing'}`, async () => {
      const m = await member()
      const headers = { 'sec-fetch-site': site }
      expect((await call('GET', '/api/me', { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('GET', '/api/org', { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('POST', '/api/signin/start', { headers })).status).toBe(403)
      expect((await call('POST', '/api/signout', { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('GET', '/api/me', { cookie: m.cookie })).status).toBe(200)
    })
  }
  for (const origin of ['https://evil.example', 'http://localhost:8788', 'https://localhost:8787', 'null', null]) {
    it(`refuses a state change with Origin ${origin ?? 'missing'}`, async () => {
      const m = await member()
      const headers = { origin }
      expect((await call('POST', '/api/signout', { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('POST', `/api/sessions/${m.sessionId}/revoke`, { cookie: m.cookie, headers })).status).toBe(403)
      expect((await call('POST', '/api/signin/start', { headers })).status).toBe(403)
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
    expect(routes.filter((route) => route.method === 'GET').map((route) => route.path).sort()).toEqual(['/api/me', '/api/org'])
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
}

describe('e. an organisation never sees another', () => {
  it('every route has an isolation case', () => {
    expect(Object.keys(isolation).sort()).toEqual(routes.map((route) => `${route.method} ${route.path}`).sort())
  })
  for (const [route, run] of Object.entries(isolation)) {
    it(route, async () => run(await member('Alder Asset Management'), await member('Birchfield Capital')))
  }
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

  // Every state change, with the table its batch writes besides audit_log.
  const changes: Record<string, { blocks: string; run: (m: Member) => Promise<unknown> }> = {
    'organisation.seed': { blocks: 'INSERT ON seats', run: () => organisation().catch(() => 'refused') },
    'credential.store': {
      blocks: 'INSERT ON credentials',
      run: async (m) => enrol((await invite(m.orgId, m.seatId, 'viewer')).ticket, await softwareAuthenticator(SITE)),
    },
    'credential.activate.dev': { blocks: 'UPDATE ON credentials', run: () => data.devActivatePending(db, 'local', now).catch(() => 'refused') },
    'session.create': { blocks: 'INSERT ON sessions', run: (m) => signIn(m.key) },
    'session.revoke': { blocks: 'UPDATE ON sessions', run: (m) => call('POST', `/api/sessions/${m.sessionId}/revoke`, { cookie: m.cookie }) },
    'session.signout': { blocks: 'UPDATE ON sessions', run: (m) => call('POST', '/api/signout', { cookie: m.cookie }) },
  }
  for (const [action, change] of Object.entries(changes)) {
    it(`${action}: the change and its audit row succeed or fail together`, async () => {
      const m = await member()
      // A viewer with a stored, pending passkey gives the activation command something to do.
      await enrol((await invite(m.orgId, m.seatId, 'viewer')).ticket, await softwareAuthenticator(SITE))
      const before = await snapshot()
      // The audit row cannot be written: the change must not happen. (The invite helper of
      // credential.store writes a seat and a ticket itself, so it compares the tables its route writes.)
      const state = action === 'credential.store' ? ['credentials', 'sessions', 'audit_log'] : TABLES
      const stateBefore = await snapshot(state)
      await withTrigger('INSERT ON audit_log', async () => void (await change.run(m)))
      expect(await snapshot(state)).toBe(stateBefore)
      // The change cannot be written: no audit row may appear.
      const rowsBefore = (await db.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>())!.n
      await withTrigger(change.blocks, async () => void (await change.run(m)))
      expect((await db.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>())!.n).toBe(rowsBefore)
      // With nothing blocked, the same call writes exactly one audit row carrying this action.
      await change.run(m)
      const last = await db.prepare('SELECT action FROM audit_log ORDER BY at DESC, rowid DESC LIMIT 1').first<{ action: string }>()
      expect(last!.action).toBe(action)
      expect((await db.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>())!.n).toBe(rowsBefore + 1)
      expect(before).not.toBe(await snapshot())
    })
  }
  it('the list above covers every state-changing route', () => {
    expect(routes.filter((route) => route.method === 'POST').map((route) => route.path).sort())
      .toEqual(['/api/enrol/finish', '/api/enrol/start', '/api/sessions/:id/revoke', '/api/signin/finish', '/api/signin/start', '/api/signout'])
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
