// The ONE data module. Every SQL statement of the app is here, prepared, with bound parameters.
// A function that acts for a signed-in member takes an Actor built from the session: the organisation
// id comes from there, never from the request. Three lookups run before a session exists (ticket token,
// credential id, session token); each finds its organisation in the row it matched.
// Every state change goes through commit(): the change and its audit row are one db.batch(), which D1
// runs as one transaction. If the audit row cannot be written, the change is not made.

export type Role = 'owner' | 'admin' | 'trader' | 'approver' | 'compliance' | 'viewer'
export const ROLES: Role[] = ['owner', 'admin', 'trader', 'approver', 'compliance', 'viewer']
/** Issuers are Owners and Admins. The second person is any other key role. A Trader or Viewer is never either. */
export const KEY_ROLES: Role[] = ['owner', 'admin', 'approver', 'compliance']
export interface Actor { orgId: string; seatId: string; sessionId: string; role: Role; quarantineUntil: number | null; country: string | null; asn: number | null }
type Sql = D1PreparedStatement

const MIN = 60_000
const HOUR = 60 * MIN
export const CONFIRM_MS = 60 * MIN // the words are typed within 60 minutes of the enrolment
const WAIT_MS = 72 * HOUR // replaces the second person when the organisation has none
const WAIT_OPEN_MS = 7 * 24 * HOUR // after the wait, the new passkey has 7 days to sign in
const ALERT_MS = 7 * 24 * HOUR
const MAX_ATTEMPTS = 3
const MAX_TICKETS = 3 // per issuer and seat per 24 hours
const MAX_PASSKEYS = 10 // active ones, per seat
/** Quarantine and the stop right last 24 hours for a Trader or Viewer, 72 hours for a key role. */
const quarantineMs = (role: Role) => (KEY_ROLES.includes(role) ? 72 : 24) * HOUR
const quarantined = (actor: Actor, now: number) => (actor.quarantineUntil ?? 0) > now
/** Nobody acts on a seat whose role is above their own. */
const mayManage = (actor: Role, target: Role) => actor === 'owner' || (actor === 'admin' && target !== 'owner')

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
  at: number; actorKind: 'seat' | 'operator' | 'anchor' | 'system'; actorId: string | null; sessionId: string | null
  action: string; subjectId: string | null; detail?: string | null; country?: string | null; asn?: number | null
}
const FIRST = '0'.repeat(64)
const auditHash = (r: Omit<AuditRow, 'hash'>) =>
  sha256Hex(JSON.stringify([r.org_id, r.seq, r.at, r.actor_kind, r.actor_id, r.session_id, r.action, r.subject_id, r.detail, r.country, r.asn, r.prev_hash]))

// Writes of one organisation are serialised by the audit sequence: two at the same instant collide on
// the primary key (org_id, seq) and the later one fails whole. So plan() runs after the head is read:
// what it reads is still true when its batch commits, or the batch fails. It returns the audit entry
// and the changes, or null to change nothing.
// ponytail: one retry after a collision, then the caller answers "try again". Ceiling: an organisation
// with many writers at the same instant. Then queue its writes (a Durable Object per organisation).
async function commit(db: D1Database, orgId: string, plan: () => [Entry, Sql[]] | null | Promise<[Entry, Sql[]] | null>) {
  for (let attempt = 0; ; attempt++) {
    const head = await db.prepare('SELECT seq, hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1').bind(orgId).first<{ seq: number; hash: string }>()
    const planned = await plan()
    if (!planned) return false
    const [e, changes] = planned
    const row = {
      org_id: orgId, seq: (head?.seq ?? 0) + 1, at: e.at, actor_kind: e.actorKind, actor_id: e.actorId, session_id: e.sessionId,
      action: e.action, subject_id: e.subjectId, detail: e.detail ?? null, country: e.country ?? null, asn: e.asn ?? null, prev_hash: head?.hash ?? FIRST,
    }
    const audit = db
      .prepare('INSERT INTO audit_log (org_id, seq, at, actor_kind, actor_id, session_id, action, subject_id, detail, country, asn, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.org_id, row.seq, row.at, row.actor_kind, row.actor_id, row.session_id, row.action, row.subject_id, row.detail, row.country, row.asn, row.prev_hash, await auditHash(row))
    try {
      await db.batch([...changes, audit])
      return true
    } catch (error) {
      if (attempt > 0 || !/audit_log\.seq/.test(String((error as Error)?.message))) throw error
    }
  }
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

export interface Ticket { id: string; org_id: string; seat_id: string; kind: string; role: Role; nonce: string; display_name: string; org_name: string; synced_keys_allowed: number }
// The ticket's role must be its seat's role: the key rule (Owners: hardware only) is read from the ticket,
// the rights of the session from the seat, so a ticket that disagrees with its seat is dead.
// A ticket is also dead once the seat that issued it is no longer active (ISSUER_ACTIVE): what a stopped or
// frozen seat had started does not go on without it. (A freeze also closes those tickets in the tables: closeOpen.)
// The first Owner's ticket has no issuer.
const ISSUER_ACTIVE = `(t.issuer_seat_id IS NULL OR EXISTS (SELECT 1 FROM seats i WHERE i.org_id = t.org_id AND i.id = t.issuer_seat_id AND i.state = 'active'))`
export function ticketByToken(db: D1Database, tokenHash: string, now: number) {
  return db
    .prepare(
      `SELECT t.id, t.org_id, t.seat_id, t.kind, t.role, t.nonce, s.display_name, o.name AS org_name, o.synced_keys_allowed
       FROM enrolment_tickets t
       JOIN seats s ON s.org_id = t.org_id AND s.id = t.seat_id AND s.role = t.role AND s.state IN ('invited', 'active')
       JOIN organisations o ON o.id = t.org_id AND o.state IN ('unverified', 'active')
       WHERE t.token_hash = ? AND t.state = 'issued' AND t.expires_at > ? AND ${ISSUER_ACTIVE}`,
    )
    .bind(tokenHash, now)
    .first<Ticket>()
}

/** Stores the new passkey as pending and kills the ticket. A pending passkey opens no session. False: the ticket was used, cancelled or killed meanwhile. */
export function storePendingCredential(
  db: D1Database,
  ticket: Ticket,
  credential: { id: string; publicKey: string; counter: number; deviceBound: boolean; transports: string[] },
  label: string,
  now: number,
) {
  return commit(db, ticket.org_id, async () => {
    // Read again here: the handler found the ticket before this write took its turn.
    if (!(await db.prepare(`SELECT 1 FROM enrolment_tickets WHERE org_id = ? AND id = ? AND state = 'issued'`).bind(ticket.org_id, ticket.id).first())) return null
    return [{ at: now, actorKind: 'seat', actorId: ticket.seat_id, sessionId: null, action: 'credential.store', subjectId: credential.id }, [
      // credentials.ticket_id is UNIQUE: a second passkey for the same ticket fails the whole batch.
      db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, ticket_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .bind(credential.id, ticket.org_id, ticket.seat_id, credential.publicKey, credential.counter, credential.deviceBound ? 1 : 0, JSON.stringify(credential.transports), label, ticket.id, now),
      db.prepare(`UPDATE enrolment_tickets SET state = 'stored', stored_at = ? WHERE org_id = ? AND id = ?`).bind(now, ticket.org_id, ticket.id),
    ]]
  })
}

export interface StoredCredential {
  id: string; org_id: string; seat_id: string; public_key: string; counter: number
  state: 'active' | 'suspended' | 'pending'; stop_right_until: number | null; ticket_id: string | null; seat_state: string
}
/** A passkey of an active organisation, with its state. The caller decides what that state may do; a revoked one does not exist here. */
export function credentialById(db: D1Database, credentialId: string) {
  return db
    .prepare(
      `SELECT c.id, c.org_id, c.seat_id, c.public_key, c.counter, c.state, c.stop_right_until, c.ticket_id, s.state AS seat_state
       FROM credentials c
       JOIN seats s ON s.org_id = c.org_id AND s.id = c.seat_id
       JOIN organisations o ON o.id = c.org_id AND o.state = 'active'
       WHERE c.id = ? AND c.state IN ('active', 'suspended', 'pending')`,
    )
    .bind(credentialId)
    .first<StoredCredential>()
}
/** A replaced passkey keeps one right until quarantine ends: to stop its replacement. */
export const hasStopRight = (c: StoredCredential, now: number) => c.state === 'suspended' && c.seat_state === 'active' && (c.stop_right_until ?? 0) > now

// Ends one ticket, with its pending passkey and its waiting confirmation.
const closeTicket = (db: D1Database, orgId: string, ticketId: string, state: 'dead' | 'cancelled', now: number): Sql[] => [
  db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND ticket_id = ? AND state = 'pending'`).bind(orgId, ticketId),
  db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND action = 'ticket.confirm' AND subject_id = ? AND state = 'pending'`).bind(now, orgId, ticketId),
  db.prepare('UPDATE enrolment_tickets SET state = ? WHERE org_id = ? AND id = ?').bind(state, orgId, ticketId),
]
// The same for every ticket a seat still has open. Run after the statements that settle the ticket that
// wins, if any: whatever is still open then is dead. `issuedToo`: also the tickets the seat issued for
// others, when it is frozen, so that unfreezing it later brings none of them back.
function closeOpen(db: D1Database, orgId: string, seatId: string, now: number, issuedToo = false): Sql[] {
  const tickets = `SELECT id FROM enrolment_tickets WHERE org_id = ? AND (seat_id = ? OR (? = 1 AND issuer_seat_id = ?)) AND state IN ('issued', 'stored')`
  const scope = [orgId, orgId, seatId, issuedToo ? 1 : 0, seatId]
  return [
    db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND state = 'pending' AND ticket_id IN (${tickets})`).bind(...scope),
    db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND action = 'ticket.confirm' AND state = 'pending' AND subject_id IN (${tickets})`).bind(now, ...scope),
    db.prepare(`UPDATE enrolment_tickets SET state = 'dead' WHERE org_id = ? AND id IN (${tickets})`).bind(...scope),
  ]
}

// If the member signs in with a passkey they still hold while a re-enrolment of their seat is open, that
// re-enrolment was not theirs: its tickets die, and the row says so (detail), which flags the issuer.
// (A seat that can sign in has no other kind of open ticket.)
export async function createSession(
  db: D1Database,
  s: { orgId: string; seatId: string; credentialId: string; counter: number; tokenHash: string; challengeHash: string; now: number; userAgent: string | null; country: string | null; asn: number | null },
) {
  const id = randomId()
  await commit(db, s.orgId, async () => {
    const open = await db.prepare(`SELECT count(*) AS n FROM enrolment_tickets WHERE org_id = ? AND seat_id = ? AND state IN ('issued', 'stored')`).bind(s.orgId, s.seatId).first<{ n: number }>()
    return [{ at: s.now, actorKind: 'seat', actorId: s.seatId, sessionId: id, action: 'session.create', subjectId: id, detail: open?.n ? 'ticket_killed' : null, country: s.country, asn: s.asn }, [
      // sessions.challenge_hash is UNIQUE: the same assertion cannot open a second session.
      db.prepare(`INSERT INTO sessions (id, token_hash, challenge_hash, org_id, seat_id, credential_id, created_at, last_seen_at, step_up_at, user_agent, country, asn)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, s.tokenHash, s.challengeHash, s.orgId, s.seatId, s.credentialId, s.now, s.now, s.now, s.userAgent, s.country, s.asn),
      // max(): two sign-ins verified at the same moment may commit out of order; the counter never goes down.
      db.prepare('UPDATE credentials SET counter = max(counter, ?), last_used_at = ? WHERE org_id = ? AND id = ?').bind(s.counter, s.now, s.orgId, s.credentialId),
      ...(open?.n ? closeOpen(db, s.orgId, s.seatId, s.now) : []),
    ]]
  })
  return id
}

export interface Session {
  id: string; org_id: string; seat_id: string; credential_id: string; created_at: number; last_seen_at: number; step_up_at: number
  role: Role; display_name: string; quarantine_until: number | null; org_name: string; org_kind: string; synced_keys_allowed: number
  /** Active passkeys of the seat; for an Owner, the device-bound ones only. Two are needed before anything sensitive. */
  strong_keys: number
}
/** A session that is not revoked, whose passkey, seat and organisation are all still active. The caller checks the time limits. */
export function sessionByToken(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT x.id, x.org_id, x.seat_id, x.credential_id, x.created_at, x.last_seen_at, x.step_up_at, s.role, s.display_name, s.quarantine_until,
              o.name AS org_name, o.kind AS org_kind, o.synced_keys_allowed,
              (SELECT count(*) FROM credentials k WHERE k.org_id = x.org_id AND k.seat_id = x.seat_id AND k.state = 'active' AND (s.role <> 'owner' OR k.device_bound = 1)) AS strong_keys
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
  await commit(db, actor.orgId, () => [{ at: now, actorKind: 'seat', actorId: actor.seatId, sessionId: actor.sessionId, action, subjectId: sessionId, country: actor.country, asn: actor.asn }, [
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND id = ?').bind(now, actor.orgId, sessionId),
  ]])
  return true
}

/** Members, passkeys and live sessions. An Owner or Admin sees the organisation; any other role sees its own seat. */
export async function organisationView(db: D1Database, actor: Actor, idleSince: number, startedSince: number) {
  const scope = [actor.orgId, seesAll(actor), actor.seatId]
  const [members, passkeys, sessions] = await db.batch([
    db.prepare('SELECT id, display_name AS displayName, role, state FROM seats WHERE org_id = ? AND (? = 1 OR id = ?) ORDER BY created_at, id').bind(...scope),
    db.prepare(`SELECT id, seat_id AS seatId, label, state, device_bound AS deviceBound, created_at AS createdAt, last_used_at AS lastUsedAt, stop_right_until AS stopRightUntil
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

// ---- step-up and the member's own passkeys ----

const seatEntry = (actor: Actor, now: number, action: string, subjectId: string, detail: string | null = null): Entry =>
  ({ at: now, actorKind: 'seat', actorId: actor.seatId, sessionId: actor.sessionId, action, subjectId, detail, country: actor.country, asn: actor.asn })
const used = (db: D1Database, orgId: string, credentialId: string, counter: number, now: number) =>
  db.prepare('UPDATE credentials SET counter = max(counter, ?), last_used_at = ? WHERE org_id = ? AND id = ?').bind(counter, now, orgId, credentialId)

/** An active passkey of the member's own seat: the only kind that passes a check inside a session. */
export function credentialOfSeat(db: D1Database, actor: Actor, credentialId: string) {
  return db.prepare(`SELECT id, public_key, counter FROM credentials WHERE org_id = ? AND seat_id = ? AND id = ? AND state = 'active'`)
    .bind(actor.orgId, actor.seatId, credentialId).first<{ id: string; public_key: string; counter: number }>()
}
/** Ids of the seat's passkeys: the active ones (to ask for a check), or every one that is not revoked (to refuse a duplicate). */
export async function seatCredentialIds(db: D1Database, actor: Actor, activeOnly: boolean) {
  const { results } = await db.prepare(`SELECT id FROM credentials WHERE org_id = ? AND seat_id = ? AND (state = 'active' OR (? = 0 AND state <> 'revoked')) ORDER BY created_at, id`)
    .bind(actor.orgId, actor.seatId, activeOnly ? 1 : 0).all<{ id: string }>()
  return results.map((row) => row.id)
}

/** A passed check: the 5 minutes start again and the session gets a new token. `seenTokenHash` is the token the challenge was bound to. */
export function stepUp(db: D1Database, actor: Actor, seenTokenHash: string, x: { credentialId: string; counter: number; tokenHash: string; now: number }) {
  return commit(db, actor.orgId, async () => {
    const session = await db.prepare('SELECT token_hash FROM sessions WHERE org_id = ? AND id = ? AND revoked_at IS NULL').bind(actor.orgId, actor.sessionId).first<{ token_hash: string }>()
    if (session?.token_hash !== seenTokenHash) return null
    return [seatEntry(actor, x.now, 'session.stepup', actor.sessionId), [
      db.prepare('UPDATE sessions SET token_hash = ?, step_up_at = ? WHERE org_id = ? AND id = ?').bind(x.tokenHash, x.now, actor.orgId, actor.sessionId),
      used(db, actor.orgId, x.credentialId, x.counter, x.now),
    ]]
  })
}

/** The member's own new passkey, active at once. The seat's other sessions end: whoever held one must sign in again and sees the alert. */
export function addCredential(db: D1Database, actor: Actor, credential: { id: string; publicKey: string; counter: number; deviceBound: boolean; transports: string[] }, label: string, now: number) {
  return commit(db, actor.orgId, async () => {
    if ((await seatCredentialIds(db, actor, true)).length >= MAX_PASSKEYS) return null
    return [seatEntry(actor, now, 'credential.add', credential.id), [
      db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
        .bind(credential.id, actor.orgId, actor.seatId, credential.publicKey, credential.counter, credential.deviceBound ? 1 : 0, JSON.stringify(credential.transports), label, now),
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND seat_id = ? AND id <> ? AND revoked_at IS NULL').bind(now, actor.orgId, actor.seatId, actor.sessionId),
    ]]
  })
}

/** Active passkeys of active seats only: a replaced (suspended) one keeps its stop right, and a frozen seat waits for two people. A colleague's last one freezes the seat. */
export async function revokeCredential(db: D1Database, actor: Actor, credentialId: string, now: number) {
  let outcome: 'ok' | 'not_found' | 'forbidden' | 'quarantine' | 'last_passkey' = 'not_found'
  await commit(db, actor.orgId, async () => {
    const c = await db
      .prepare(`SELECT c.seat_id, s.role, (SELECT count(*) FROM credentials k WHERE k.org_id = c.org_id AND k.seat_id = c.seat_id AND k.state = 'active') AS active
                FROM credentials c JOIN seats s ON s.org_id = c.org_id AND s.id = c.seat_id AND s.state = 'active'
                WHERE c.org_id = ? AND c.id = ? AND c.state = 'active' AND (c.seat_id = ? OR ? = 1)`)
      .bind(actor.orgId, credentialId, actor.seatId, seesAll(actor)).first<{ seat_id: string; role: Role; active: number }>()
    if (!c) outcome = 'not_found'
    else if (c.seat_id === actor.seatId) outcome = c.active < 2 ? 'last_passkey' : 'ok'
    else outcome = !mayManage(actor.role, c.role) ? 'forbidden' : quarantined(actor, now) ? 'quarantine' : 'ok'
    if (!c || outcome !== 'ok') return null
    // A colleague who removes the last passkey of a seat leaves its member nothing to stop a replacement with.
    // So that seat is frozen, with what it had open: no ticket is issued for a frozen seat, and unfreezing
    // takes two people (milestone 3). To replace lost passkeys, a colleague re-enrols; they do not revoke.
    const freeze = c.seat_id !== actor.seatId && c.active < 2
    return [seatEntry(actor, now, 'credential.revoke', credentialId, freeze ? 'seat_frozen' : null), [
      db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND id = ?`).bind(actor.orgId, credentialId),
      ...(freeze ? [db.prepare(`UPDATE seats SET state = 'frozen' WHERE org_id = ? AND id = ?`).bind(actor.orgId, c.seat_id), ...closeOpen(db, actor.orgId, c.seat_id, now, true)] : []),
    ]]
  })
  return outcome as 'ok' | 'not_found' | 'forbidden' | 'quarantine' | 'last_passkey' // the plan assigns it; the compiler cannot see that
}

// ---- enrolment tickets and the three-word ceremony (recovery.md section 2) ----

type Target = { seatId: string } | { displayName: string; role: Role }
/** An invitation (a new seat, or a seat that never enrolled) or the re-enrolment of an active seat. The seat decides which. */
export async function issueTicket(db: D1Database, actor: Actor, target: Target, tokenHash: string, now: number) {
  const ticketId = randomId()
  const newSeatId = randomId()
  type Issued = { error: 'not_found' | 'forbidden' | 'quarantine' | 'ticket_limit' } | { error?: undefined; ticketId: string; seatId: string; kind: string; role: Role; expiresAt: number }
  let outcome: Issued = { error: 'not_found' }
  await commit(db, actor.orgId, async () => {
    let seat: { id: string; role: Role; state: string } | null = 'seatId' in target ? null : { id: newSeatId, role: target.role, state: 'new' }
    // A member does not re-enrol their own seat: they add a passkey after a check from one they hold.
    if ('seatId' in target && target.seatId !== actor.seatId) {
      seat = await db.prepare(`SELECT id, role, state FROM seats WHERE org_id = ? AND id = ? AND state IN ('invited', 'active')`).bind(actor.orgId, target.seatId).first<{ id: string; role: Role; state: string }>()
    }
    if (!seat) return null
    const kind = seat.state === 'active' ? 're_enrolment' : 'invitation'
    const issued = await db.prepare('SELECT count(*) AS n FROM enrolment_tickets WHERE org_id = ? AND issuer_seat_id = ? AND seat_id = ? AND created_at > ?')
      .bind(actor.orgId, actor.seatId, seat.id, now - 24 * HOUR).first<{ n: number }>()
    const refused = !mayManage(actor.role, seat.role) ? 'forbidden'
      : kind === 'invitation' && quarantined(actor, now) ? 'quarantine' // a new member; re-enrolling an existing seat stays open
      : issued!.n >= MAX_TICKETS ? 'ticket_limit'
      : null
    if (refused) {
      outcome = { error: refused }
      return null
    }
    const expiresAt = now + (KEY_ROLES.includes(seat.role) ? 10 * MIN : 24 * HOUR)
    outcome = { ticketId, seatId: seat.id, kind, role: seat.role, expiresAt }
    return [seatEntry(actor, now, 'ticket.issue', ticketId, kind), [
      ...('seatId' in target ? [] : [db.prepare(`INSERT INTO seats (id, org_id, display_name, role, state, created_at) VALUES (?, ?, ?, ?, 'invited', ?)`).bind(seat.id, actor.orgId, target.displayName, seat.role, now)]),
      db.prepare(`INSERT INTO enrolment_tickets (id, org_id, seat_id, kind, role, issuer_seat_id, token_hash, nonce, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`)
        .bind(ticketId, actor.orgId, seat.id, kind, seat.role, actor.seatId, tokenHash, randomId(), expiresAt, now),
    ]]
  })
  return outcome as Issued
}

export interface OpenTicket {
  id: string; kind: 'first_owner' | 'invitation' | 're_enrolment'; role: Role; state: string; seat_id: string; issuer_seat_id: string | null; display_name: string
  nonce: string; attempts: number; expires_at: number; stored_at: number | null
  credential_id: string | null; public_key: string | null; approval_id: string | null; not_before: number | null; approval_expires_at: number | null
  /** link: waits for the member's passkey. issuer: waits for the issuer's words. second: for a second person's. wait: for the 72 hours. */
  status: 'link' | 'issuer' | 'second' | 'wait'
  /** What the viewer may do now. */
  myStep: 'issuer' | 'second' | null
  until: number
}
// Every open ticket of the organisation that is still alive, with the step the viewer may take. A ticket
// whose seat or issuer is not in the right state, or whose time is up, is not here: it is dead without a write.
// The rows carry the nonce: openTickets() below is the only shape that leaves the server.
async function ticketRows(db: D1Database, viewer: Pick<Actor, 'orgId' | 'seatId' | 'role'>, now: number, ticketId: string | null = null) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.kind, t.role, t.state, t.seat_id, t.issuer_seat_id, s.display_name, t.nonce, t.attempts, t.expires_at, t.stored_at,
              c.id AS credential_id, c.public_key, a.id AS approval_id, a.not_before, a.expires_at AS approval_expires_at
       FROM enrolment_tickets t
       JOIN seats s ON s.org_id = t.org_id AND s.id = t.seat_id AND s.role = t.role AND s.state = CASE t.kind WHEN 're_enrolment' THEN 'active' ELSE 'invited' END
       LEFT JOIN credentials c ON c.org_id = t.org_id AND c.ticket_id = t.id AND c.state = 'pending'
       LEFT JOIN approvals a ON a.org_id = t.org_id AND a.subject_id = t.id AND a.action = 'ticket.confirm' AND a.state = 'pending'
       WHERE t.org_id = ? AND t.state IN ('issued', 'stored') AND (? IS NULL OR t.id = ?) AND ${ISSUER_ACTIVE}
       ORDER BY t.created_at, t.id`,
    )
    .bind(viewer.orgId, ticketId, ticketId)
    .all<OpenTicket>()
  return results.flatMap((t): OpenTicket[] => {
    if (t.state === 'stored' && (!t.credential_id || t.stored_at === null)) return []
    const [status, until] =
      t.state === 'issued' ? (['link', t.expires_at] as const)
      : !t.approval_id ? (['issuer', t.stored_at! + CONFIRM_MS] as const)
      : ([t.not_before === null ? 'second' : 'wait', t.approval_expires_at!] as const)
    // A link is dead at its expiry; the other steps include their last millisecond.
    if (status === 'link' ? until <= now : until < now) return []
    const myStep =
      status === 'issuer' && viewer.seatId === t.issuer_seat_id ? 'issuer'
      : status === 'second' && KEY_ROLES.includes(viewer.role) && viewer.seatId !== t.issuer_seat_id && viewer.seatId !== t.seat_id ? 'second'
      : null
    return [{ ...t, status, myStep, until: status === 'wait' ? t.not_before! : until }]
  })
}

/** For the "Waiting for confirmation" list. An Owner or Admin sees every open ticket; anyone else only those waiting for their words. No secret field. */
export async function openTickets(db: D1Database, actor: Actor, now: number) {
  return (await ticketRows(db, actor, now))
    .filter((t) => seesAll(actor) === 1 || t.myStep)
    .map((t) => ({ id: t.id, kind: t.kind, role: t.role, seatId: t.seat_id, name: t.display_name, issuerSeatId: t.issuer_seat_id, status: t.status, myStep: t.myStep, until: t.until }))
}
/** The ticket, if the member may type its words now. */
export const ticketToConfirm = async (db: D1Database, actor: Actor, ticketId: string, now: number) =>
  (await ticketRows(db, actor, now, ticketId)).find((t) => t.myStep) ?? null

// Step 8: the new passkey is active; on a re-enrolment the previous ones are suspended and keep the stop
// right, and the seat is in quarantine; the seat's sessions end; everything else it had open is dead.
function activation(db: D1Database, orgId: string, t: OpenTicket, now: number, checkerSeatId: string | null): Sql[] {
  const until = t.kind === 're_enrolment' ? now + quarantineMs(t.role) : null
  return [
    ...(until === null ? [] : [db.prepare(`UPDATE credentials SET state = 'suspended', stop_right_until = ? WHERE org_id = ? AND seat_id = ? AND state = 'active'`).bind(until, orgId, t.seat_id)]),
    db.prepare(`UPDATE credentials SET state = 'active' WHERE org_id = ? AND id = ? AND state = 'pending'`).bind(orgId, t.credential_id),
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND seat_id = ? AND revoked_at IS NULL').bind(now, orgId, t.seat_id),
    db.prepare(`UPDATE seats SET state = 'active', quarantine_until = ? WHERE org_id = ? AND id = ?`).bind(until, orgId, t.seat_id),
    db.prepare(`UPDATE enrolment_tickets SET state = 'confirmed' WHERE org_id = ? AND id = ?`).bind(orgId, t.id),
    db.prepare(`UPDATE approvals SET state = 'applied', checker_seat_id = ?, decided_at = ? WHERE org_id = ? AND id = ?`).bind(checkerSeatId, now, orgId, t.approval_id),
    ...closeOpen(db, orgId, t.seat_id, now),
  ]
}

type Confirmed = { state: 'active' | 'second' | 'gone' | 'dead' } | { state: 'wait'; waitUntil: number } | { state: 'wrong'; left: number }
/** The words were typed and the passkey check passed. `seen` is the ticket as the check saw it: if it moved since, nothing is written. */
export async function confirmTicket(db: D1Database, actor: Actor, seen: OpenTicket, x: { correct: boolean; credentialHash: string; credentialId: string; counter: number; now: number }) {
  let outcome: Confirmed = { state: 'gone' }
  const { now } = x
  await commit(db, actor.orgId, async () => {
    const t = await ticketToConfirm(db, actor, seen.id, now)
    outcome = { state: 'gone' }
    if (!t || t.attempts !== seen.attempts || t.credential_id !== seen.credential_id) return null
    const check = used(db, actor.orgId, x.credentialId, x.counter, now)
    if (!x.correct) {
      // The counter is exact: it is added to in the database, in the same batch as its audit row.
      const dead = t.attempts + 1 >= MAX_ATTEMPTS
      outcome = dead ? { state: 'dead' } : { state: 'wrong', left: MAX_ATTEMPTS - t.attempts - 1 }
      return [seatEntry(actor, now, 'ticket.attempt', t.id, dead ? 'dead' : 'wrong'), [
        check,
        db.prepare('UPDATE enrolment_tickets SET attempts = attempts + 1 WHERE org_id = ? AND id = ?').bind(actor.orgId, t.id),
        ...(dead ? closeTicket(db, actor.orgId, t.id, 'dead', now) : []),
      ]]
    }
    if (t.myStep === 'issuer' && KEY_ROLES.includes(t.role)) {
      const others = await db.prepare(`SELECT count(*) AS n FROM seats WHERE org_id = ? AND state = 'active' AND role IN ('owner', 'admin', 'approver', 'compliance') AND id NOT IN (?, ?)`)
        .bind(actor.orgId, actor.seatId, t.seat_id).first<{ n: number }>()
      const waitUntil = others!.n ? null : now + WAIT_MS
      outcome = waitUntil === null ? { state: 'second' } : { state: 'wait', waitUntil }
      return [seatEntry(actor, now, 'ticket.confirm', t.id, waitUntil === null ? 'second' : 'wait'), [
        check,
        // approvals has CHECK (checker <> requester): the issuer can never be recorded as the second person.
        db.prepare(`INSERT INTO approvals (id, org_id, action, subject_id, payload_hash, requester_seat_id, state, not_before, expires_at, created_at) VALUES (?, ?, 'ticket.confirm', ?, ?, ?, 'pending', ?, ?, ?)`)
          .bind(randomId(), actor.orgId, t.id, x.credentialHash, actor.seatId, waitUntil, waitUntil === null ? t.stored_at! + CONFIRM_MS : waitUntil + WAIT_OPEN_MS, now),
        db.prepare('UPDATE enrolment_tickets SET wait_until = ? WHERE org_id = ? AND id = ?').bind(waitUntil, actor.orgId, t.id),
      ]]
    }
    outcome = { state: 'active' }
    return [seatEntry(actor, now, 'credential.activate', t.credential_id!, t.myStep), [check, ...activation(db, actor.orgId, t, now, t.myStep === 'second' ? actor.seatId : null)]]
  })
  return outcome as Confirmed
}

/** The 72 hours have passed with no cancel: the pending passkey becomes active at its first sign-in. No scheduled job. */
export function activateAfterWait(db: D1Database, credential: StoredCredential, now: number) {
  return commit(db, credential.org_id, async () => {
    const [t] = credential.ticket_id ? await ticketRows(db, { orgId: credential.org_id, seatId: credential.seat_id, role: 'viewer' }, now, credential.ticket_id) : []
    if (!t || t.status !== 'wait' || t.until > now || t.credential_id !== credential.id) return null
    return [{ at: now, actorKind: 'seat', actorId: credential.seat_id, sessionId: null, action: 'credential.activate', subjectId: credential.id, detail: 'wait' }, activation(db, credential.org_id, t, now, null)]
  })
}

/** Any ticket that is still open, with its pending passkey and its waiting confirmation. The caller has checked that the actor is an Owner. */
export function cancelTicket(db: D1Database, actor: Actor, ticketId: string, now: number) {
  return commit(db, actor.orgId, async () => {
    const t = await db.prepare(`SELECT id FROM enrolment_tickets WHERE org_id = ? AND id = ? AND state IN ('issued', 'stored')`).bind(actor.orgId, ticketId).first()
    if (!t) return null
    return [seatEntry(actor, now, 'ticket.cancel', ticketId), closeTicket(db, actor.orgId, ticketId, 'cancelled', now)]
  })
}

// The stop right (recovery.md section 1): the replacement and everything it added is revoked, the replaced
// passkeys are active again, and the seat is frozen until an Owner and a second person decide (milestone 3).
// ponytail: after two re-enrolments inside one quarantine, the passkeys of both earlier rounds come back.
// The freeze is what makes that safe; milestone 3 chooses which stand.
export function stopReplacement(db: D1Database, credential: StoredCredential, counter: number, now: number) {
  const { org_id: orgId, seat_id: seatId } = credential
  return commit(db, orgId, async () => {
    const current = await credentialById(db, credential.id)
    if (!current || !hasStopRight(current, now)) return null
    return [{ at: now, actorKind: 'seat', actorId: seatId, sessionId: null, action: 'credential.stop', subjectId: credential.id }, [
      db.prepare(`UPDATE credentials SET state = CASE state WHEN 'suspended' THEN 'active' ELSE 'revoked' END, stop_right_until = NULL
                  WHERE org_id = ? AND seat_id = ? AND (state = 'active' OR (state = 'suspended' AND stop_right_until > ?))`).bind(orgId, seatId, now),
      used(db, orgId, credential.id, counter, now),
      db.prepare(`UPDATE seats SET state = 'frozen', quarantine_until = NULL WHERE org_id = ? AND id = ?`).bind(orgId, seatId),
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND seat_id = ? AND revoked_at IS NULL').bind(now, orgId, seatId),
      ...closeOpen(db, orgId, seatId, now, true),
    ]]
  })
}

// ---- alerts: no email exists, so a member is told at sign-in (recovery.md section 1) ----

export interface Alert { key: string; kind: string; at?: number; until?: number; name?: string }
// ponytail: alerts are read from the rows of the last 7 days on each /api/me; the server keeps no "seen"
// mark (the browser remembers what was read). Add a table if an alert must be acknowledged by name.
export async function alertsFor(db: D1Database, actor: Actor, now: number) {
  const since = now - ALERT_MS
  const [tickets, added, frozen, closed] = await db.batch([
    // The member's own re-enrolments, and every confirmed ticket of a colleague that this member did not issue.
    db.prepare(`SELECT t.id, t.kind, t.state, t.seat_id, t.created_at, s.display_name FROM enrolment_tickets t JOIN seats s ON s.org_id = t.org_id AND s.id = t.seat_id
                WHERE t.org_id = ? AND t.created_at > ? AND ((t.kind = 're_enrolment' AND t.seat_id = ?) OR (t.state = 'confirmed' AND t.seat_id <> ? AND t.issuer_seat_id <> ?))
                ORDER BY t.created_at, t.id`).bind(actor.orgId, since, actor.seatId, actor.seatId, actor.seatId),
    db.prepare(`SELECT subject_id, at FROM audit_log WHERE org_id = ? AND actor_id = ? AND action = 'credential.add' AND at > ? AND session_id <> ? ORDER BY seq`).bind(actor.orgId, actor.seatId, since, actor.sessionId),
    db.prepare(`SELECT id, display_name FROM seats WHERE org_id = ? AND state = 'frozen' ORDER BY created_at, id`).bind(actor.orgId),
    // "The issuer is flagged": a sign-in that closed a re-enrolment is shown to the people who can issue one.
    db.prepare(`SELECT a.subject_id AS id, a.at, s.display_name FROM audit_log a JOIN seats s ON s.org_id = a.org_id AND s.id = a.actor_id
                WHERE a.org_id = ? AND a.action = 'session.create' AND a.detail = 'ticket_killed' AND a.at > ? AND a.actor_id <> ? AND ? = 1 ORDER BY a.seq`).bind(actor.orgId, since, actor.seatId, seesAll(actor)),
  ])
  const waiting = (await openTickets(db, actor, now)).filter((t) => t.myStep)
  return [
    ...(quarantined(actor, now) ? [{ key: `quarantine:${actor.quarantineUntil}`, kind: 'quarantine', until: actor.quarantineUntil! }] : []),
    ...(tickets.results as { id: string; kind: string; state: string; seat_id: string; created_at: number; display_name: string }[]).map((t) =>
      t.seat_id !== actor.seatId ? { key: `re:${t.id}`, kind: t.kind === 're_enrolment' ? 'colleague_re_enrolled' : 'colleague_joined', at: t.created_at, name: t.display_name }
      : { key: `re:${t.id}:${t.state}`, kind: t.state === 'confirmed' ? 're_enrolment_completed' : 're_enrolment_started', at: t.created_at }),
    ...(added.results as { subject_id: string; at: number }[]).map((c) => ({ key: `key:${c.subject_id}`, kind: 'new_passkey', at: c.at })),
    ...(frozen.results as { id: string; display_name: string }[]).map((seat) => ({ key: `frozen:${seat.id}`, kind: 'seat_frozen', name: seat.display_name })),
    ...(closed.results as { id: string; at: number; display_name: string }[]).map((s) => ({ key: `closed:${s.id}`, kind: 're_enrolment_closed', at: s.at, name: s.display_name })),
    ...waiting.map((t) => ({ key: `wait:${t.id}:${t.myStep}`, kind: 'confirmation_waiting', name: t.name })),
  ] satisfies Alert[]
}

// ---- local development only: no route calls these ----

/** One organisation, its first Owner seat and a one-time enrolment ticket (10 minutes: a key role). */
export async function seedOrganisation(db: D1Database, o: { name: string; kind: 'partner' | 'institution'; ownerName: string; ticketHash: string; now: number }) {
  const orgId = randomId()
  const seatId = randomId()
  const ticketId = randomId()
  await commit(db, orgId, () => [{ at: o.now, actorKind: 'system', actorId: null, sessionId: null, action: 'organisation.seed', subjectId: orgId }, [
    db.prepare(`INSERT INTO organisations (id, kind, name, state, created_at) VALUES (?, ?, ?, 'active', ?)`).bind(orgId, o.kind, o.name, o.now),
    db.prepare(`INSERT INTO seats (id, org_id, display_name, role, state, created_at) VALUES (?, ?, ?, 'owner', 'invited', ?)`).bind(seatId, orgId, o.ownerName, o.now),
    db.prepare(`INSERT INTO enrolment_tickets (id, org_id, seat_id, kind, role, token_hash, nonce, state, expires_at, created_at)
                VALUES (?, ?, ?, 'first_owner', 'owner', ?, ?, 'issued', ?, ?)`).bind(ticketId, orgId, seatId, o.ticketHash, randomId(), o.now + 10 * 60_000, o.now),
  ]])
  return { orgId, seatId }
}

// ponytail: stands in for the first Owner's activation, which the recovery anchor confirms in milestone 4
// (recovery.md section 3). It activates every pending passkey, so it must never see a real database.
export async function devActivatePending(db: D1Database, environment: string, now: number) {
  if (environment !== 'local') throw new Error('refused: activation by command is for the local database only')
  const { results } = await db.prepare(`SELECT id, org_id, seat_id, ticket_id FROM credentials WHERE state = 'pending'`).all<{ id: string; org_id: string; seat_id: string; ticket_id: string | null }>()
  for (const c of results) {
    await commit(db, c.org_id, () => [{ at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'credential.activate.dev', subjectId: c.id }, [
      db.prepare(`UPDATE credentials SET state = 'active' WHERE org_id = ? AND id = ? AND state = 'pending'`).bind(c.org_id, c.id),
      db.prepare(`UPDATE seats SET state = 'active' WHERE org_id = ? AND id = ? AND state = 'invited'`).bind(c.org_id, c.seat_id),
      db.prepare(`UPDATE enrolment_tickets SET state = 'confirmed' WHERE org_id = ? AND id = ?`).bind(c.org_id, c.ticket_id),
    ]])
  }
  return results.length
}
