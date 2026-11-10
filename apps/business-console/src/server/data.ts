// The ONE data module. Every SQL statement of the app is here, prepared, with bound parameters.
// A function that acts for a signed-in member takes an Actor built from the session: the organisation
// id comes from there, never from the request. Three lookups run before a session exists (ticket token,
// credential id, session token); each finds its organisation in the row it matched.
// Every state change goes through commit(): the change and its audit row are one db.batch(), which D1
// runs as one transaction. If the audit row cannot be written, the change is not made.

export type Role = 'owner' | 'admin' | 'trader' | 'approver' | 'compliance' | 'viewer'
export interface Actor { orgId: string; seatId: string; sessionId: string; role: Role; country: string | null; asn: number | null }
type Sql = D1PreparedStatement

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)))
/** 256 random bits, base64url. Only its SHA-256 is ever stored. */
export const randomToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const sha256Hex = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))

// ---- audit log: ids only, one hash chain per organisation ----

interface AuditRow {
  org_id: string; seq: number; at: number; actor_kind: string; actor_id: string | null; session_id: string | null
  action: string; subject_id: string | null; detail: string | null; country: string | null; asn: number | null
  prev_hash: string; hash: string
}
interface Entry {
  orgId: string; at: number; actorKind: 'seat' | 'operator' | 'anchor' | 'system'; actorId: string | null; sessionId: string | null
  action: string; subjectId: string | null; country?: string | null; asn?: number | null
}
const FIRST = '0'.repeat(64)
const auditHash = (r: Omit<AuditRow, 'hash'>) =>
  sha256Hex(JSON.stringify([r.org_id, r.seq, r.at, r.actor_kind, r.actor_id, r.session_id, r.action, r.subject_id, r.detail, r.country, r.asn, r.prev_hash]))

// ponytail: writes of one organisation are serialised by the audit sequence. Two at the same instant
// collide on the primary key (org_id, seq); one fails whole and the caller answers "try again".
// Ceiling: an organisation with many concurrent writers. Then retry here, once.
async function commit(db: D1Database, e: Entry, changes: Sql[]) {
  const head = await db.prepare('SELECT seq, hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1').bind(e.orgId).first<{ seq: number; hash: string }>()
  const row = {
    org_id: e.orgId, seq: (head?.seq ?? 0) + 1, at: e.at, actor_kind: e.actorKind, actor_id: e.actorId, session_id: e.sessionId,
    action: e.action, subject_id: e.subjectId, detail: null, country: e.country ?? null, asn: e.asn ?? null, prev_hash: head?.hash ?? FIRST,
  }
  const audit = db
    .prepare('INSERT INTO audit_log (org_id, seq, at, actor_kind, actor_id, session_id, action, subject_id, detail, country, asn, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.org_id, row.seq, row.at, row.actor_kind, row.actor_id, row.session_id, row.action, row.subject_id, row.detail, row.country, row.asn, row.prev_hash, await auditHash(row))
  await db.batch([...changes, audit])
}

// ponytail: reads the whole chain of one organisation. Page it, or start from the last anchored
// root, when a chain passes about 10,000 rows. A removed tail needs the external anchor (later milestone).
export async function verifyAudit(db: D1Database, orgId: string): Promise<{ ok: true; rows: number; head: string } | { ok: false; seq: number }> {
  const { results } = await db.prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY seq').bind(orgId).all<AuditRow>()
  let prev = FIRST
  for (const row of results) {
    if (row.prev_hash !== prev || row.hash !== (await auditHash(row))) return { ok: false, seq: row.seq }
    prev = row.hash
  }
  return { ok: true, rows: results.length, head: prev }
}

// ---- before a session exists ----

export interface Ticket { id: string; org_id: string; seat_id: string; role: Role; display_name: string; org_name: string; synced_keys_allowed: number }
export function ticketByToken(db: D1Database, tokenHash: string, now: number) {
  return db
    .prepare(
      `SELECT t.id, t.org_id, t.seat_id, t.role, s.display_name, o.name AS org_name, o.synced_keys_allowed
       FROM enrolment_tickets t
       JOIN seats s ON s.org_id = t.org_id AND s.id = t.seat_id AND s.state IN ('invited', 'active')
       JOIN organisations o ON o.id = t.org_id AND o.state IN ('unverified', 'active')
       WHERE t.token_hash = ? AND t.state = 'issued' AND t.expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<Ticket>()
}

/** Stores the new passkey as pending and kills the ticket. A pending passkey opens no session. */
export async function storePendingCredential(
  db: D1Database,
  ticket: Ticket,
  credential: { id: string; publicKey: string; counter: number; deviceBound: boolean; transports: string[] },
  label: string,
  now: number,
) {
  await commit(db, { orgId: ticket.org_id, at: now, actorKind: 'seat', actorId: ticket.seat_id, sessionId: null, action: 'credential.store', subjectId: credential.id }, [
    // credentials.ticket_id is UNIQUE: a second passkey for the same ticket fails the whole batch.
    db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, ticket_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(credential.id, ticket.org_id, ticket.seat_id, credential.publicKey, credential.counter, credential.deviceBound ? 1 : 0, JSON.stringify(credential.transports), label, ticket.id, now),
    db.prepare(`UPDATE enrolment_tickets SET state = 'stored', stored_at = ? WHERE org_id = ? AND id = ?`).bind(now, ticket.org_id, ticket.id),
  ])
}

/** Only an active passkey of an active seat in an active organisation. Pending, suspended and revoked ones do not exist here. */
export function credentialForSignIn(db: D1Database, credentialId: string) {
  return db
    .prepare(
      `SELECT c.id, c.org_id, c.seat_id, c.public_key, c.counter
       FROM credentials c
       JOIN seats s ON s.org_id = c.org_id AND s.id = c.seat_id AND s.state = 'active'
       JOIN organisations o ON o.id = c.org_id AND o.state = 'active'
       WHERE c.id = ? AND c.state = 'active'`,
    )
    .bind(credentialId)
    .first<{ id: string; org_id: string; seat_id: string; public_key: string; counter: number }>()
}

export async function createSession(
  db: D1Database,
  s: { orgId: string; seatId: string; credentialId: string; counter: number; tokenHash: string; challengeHash: string; now: number; userAgent: string | null; country: string | null; asn: number | null },
) {
  const id = randomId()
  await commit(db, { orgId: s.orgId, at: s.now, actorKind: 'seat', actorId: s.seatId, sessionId: id, action: 'session.create', subjectId: id, country: s.country, asn: s.asn }, [
    // sessions.challenge_hash is UNIQUE: the same assertion cannot open a second session.
    db.prepare(`INSERT INTO sessions (id, token_hash, challenge_hash, org_id, seat_id, credential_id, created_at, last_seen_at, step_up_at, user_agent, country, asn)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, s.tokenHash, s.challengeHash, s.orgId, s.seatId, s.credentialId, s.now, s.now, s.now, s.userAgent, s.country, s.asn),
    db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE org_id = ? AND id = ?').bind(s.counter, s.now, s.orgId, s.credentialId),
  ])
  return id
}

export interface Session {
  id: string; org_id: string; seat_id: string; created_at: number; last_seen_at: number
  role: Role; display_name: string; org_name: string; org_kind: string
}
/** A session that is not revoked, whose passkey, seat and organisation are all still active. The caller checks the two time limits. */
export function sessionByToken(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT x.id, x.org_id, x.seat_id, x.created_at, x.last_seen_at, s.role, s.display_name, o.name AS org_name, o.kind AS org_kind
       FROM sessions x
       JOIN credentials c ON c.org_id = x.org_id AND c.id = x.credential_id AND c.state = 'active'
       JOIN seats s ON s.org_id = x.org_id AND s.id = x.seat_id AND s.state = 'active'
       JOIN organisations o ON o.id = x.org_id AND o.state = 'active'
       WHERE x.token_hash = ? AND x.revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<Session>()
}

// ---- for a signed-in member: the organisation comes from the Actor ----

/** The one write with no audit row: it only moves the idle clock. */
export async function touchSession(db: D1Database, actor: Pick<Actor, 'orgId' | 'sessionId'>, now: number) {
  await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE org_id = ? AND id = ?').bind(now, actor.orgId, actor.sessionId).run()
}

const seesAll = (actor: Actor) => (actor.role === 'owner' || actor.role === 'admin' ? 1 : 0)

/** Members end their own sessions. An Owner or Admin may end any session of the organisation. */
export async function revokeSession(db: D1Database, actor: Actor, sessionId: string, action: 'session.revoke' | 'session.signout', now: number) {
  const found = await db
    .prepare('SELECT id FROM sessions WHERE org_id = ? AND id = ? AND revoked_at IS NULL AND (seat_id = ? OR ? = 1)')
    .bind(actor.orgId, sessionId, actor.seatId, seesAll(actor))
    .first()
  if (!found) return false
  await commit(db, { orgId: actor.orgId, at: now, actorKind: 'seat', actorId: actor.seatId, sessionId: actor.sessionId, action, subjectId: sessionId, country: actor.country, asn: actor.asn }, [
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND id = ?').bind(now, actor.orgId, sessionId),
  ])
  return true
}

/** Members, passkeys and live sessions. An Owner or Admin sees the organisation; any other role sees its own seat. */
export async function organisationView(db: D1Database, actor: Actor, idleSince: number, startedSince: number) {
  const scope = [actor.orgId, seesAll(actor), actor.seatId]
  const [members, passkeys, sessions] = await db.batch([
    db.prepare('SELECT id, display_name AS displayName, role, state FROM seats WHERE org_id = ? AND (? = 1 OR id = ?) ORDER BY created_at, id').bind(...scope),
    db.prepare(`SELECT seat_id AS seatId, label, state, device_bound AS deviceBound, created_at AS createdAt, last_used_at AS lastUsedAt
                FROM credentials WHERE org_id = ? AND (? = 1 OR seat_id = ?) ORDER BY created_at, id`).bind(...scope),
    db.prepare(`SELECT id, seat_id AS seatId, created_at AS createdAt, last_seen_at AS lastSeenAt, user_agent AS userAgent, country
                FROM sessions WHERE org_id = ? AND (? = 1 OR seat_id = ?) AND revoked_at IS NULL AND last_seen_at >= ? AND created_at >= ?
                ORDER BY created_at DESC, id`).bind(...scope, idleSince, startedSince),
  ])
  return {
    members: members.results,
    passkeys: (passkeys.results as Record<string, unknown>[]).map((p) => ({ ...p, deviceBound: p.deviceBound === 1 })),
    sessions: sessions.results,
  }
}

// ---- local development only: no route calls these ----

/** One organisation, its first Owner seat and a one-time enrolment ticket (10 minutes: a key role). */
export async function seedOrganisation(db: D1Database, o: { name: string; kind: 'partner' | 'institution'; ownerName: string; ticketHash: string; now: number }) {
  const orgId = randomId()
  const seatId = randomId()
  const ticketId = randomId()
  await commit(db, { orgId, at: o.now, actorKind: 'system', actorId: null, sessionId: null, action: 'organisation.seed', subjectId: orgId }, [
    db.prepare(`INSERT INTO organisations (id, kind, name, state, created_at) VALUES (?, ?, ?, 'active', ?)`).bind(orgId, o.kind, o.name, o.now),
    db.prepare(`INSERT INTO seats (id, org_id, display_name, role, state, created_at) VALUES (?, ?, ?, 'owner', 'invited', ?)`).bind(seatId, orgId, o.ownerName, o.now),
    db.prepare(`INSERT INTO enrolment_tickets (id, org_id, seat_id, kind, role, token_hash, nonce, state, expires_at, created_at)
                VALUES (?, ?, ?, 'first_owner', 'owner', ?, ?, 'issued', ?, ?)`).bind(ticketId, orgId, seatId, o.ticketHash, randomId(), o.now + 10 * 60_000, o.now),
  ])
  return { orgId, seatId }
}

// ponytail: stands in for the three-word ceremony until milestone 2 (recovery.md section 2), which
// replaces this command. It activates every pending passkey, so it must never see a real database.
export async function devActivatePending(db: D1Database, environment: string, now: number) {
  if (environment !== 'local') throw new Error('refused: activation by command is for the local database only')
  const { results } = await db.prepare(`SELECT id, org_id, seat_id, ticket_id FROM credentials WHERE state = 'pending'`).all<{ id: string; org_id: string; seat_id: string; ticket_id: string | null }>()
  for (const c of results) {
    await commit(db, { orgId: c.org_id, at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'credential.activate.dev', subjectId: c.id }, [
      db.prepare(`UPDATE credentials SET state = 'active' WHERE org_id = ? AND id = ? AND state = 'pending'`).bind(c.org_id, c.id),
      db.prepare(`UPDATE seats SET state = 'active' WHERE org_id = ? AND id = ? AND state = 'invited'`).bind(c.org_id, c.seat_id),
      db.prepare(`UPDATE enrolment_tickets SET state = 'confirmed' WHERE org_id = ? AND id = ?`).bind(c.org_id, c.ticket_id),
    ])
  }
  return results.length
}
