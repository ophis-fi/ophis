// The ONE data module. Every SQL statement of the app is here, prepared, with bound parameters.
// A function that acts for a signed-in member takes an Actor built from the session: the organisation
// id comes from there, never from the request. Three lookups run before a session exists (ticket token,
// credential id, session token); each finds its organisation in the row it matched.
// Every state change goes through commit(): the change and its audit row are one db.batch(), which D1
// runs as one transaction. If the audit row cannot be written, the change is not made.

import { checksum, colour, type SafeState } from './chain.ts'
import { LISTS } from './typed.ts'
import { again, APPROVE_MS, MAX_OPEN_ORDERS, MIN_VALID_MS, PREPARERS, SIGN_MS, SIGNERS, type Terms } from './orders.ts'

export type Role = 'owner' | 'admin' | 'trader' | 'approver' | 'compliance' | 'viewer'
export const ROLES: Role[] = ['owner', 'admin', 'trader', 'approver', 'compliance', 'viewer']
/** Issuers are Owners and Admins. The second person is any other key role. A Trader or Viewer is never either. */
export const KEY_ROLES: Role[] = ['owner', 'admin', 'approver', 'compliance']
export interface Actor { orgId: string; seatId: string; sessionId: string; role: Role; quarantineUntil: number | null; country: string | null; asn: number | null }
type Sql = D1PreparedStatement

const MIN = 60_000
const HOUR = 60 * MIN
const CONFIRM_MS = 60 * MIN // the issuer, and a second person where one is needed, confirm within 60 minutes of the enrolment
const WAIT_MS = 72 * HOUR // replaces the second person when the organisation has none
const WAIT_OPEN_MS = 7 * 24 * HOUR // after the wait, the new passkey has 7 days to sign in
const ALERT_MS = 7 * 24 * HOUR
const MAX_TICKETS = 3 // per issuer and seat per 24 hours
const MAX_PASSKEYS = 10 // active ones, per seat
const DAY = 24 * HOUR
// The longest a ticket can live: 24 h link, 60 min for the confirmation, 72 h wait, 7 days to sign in. After 12 days
// a ticket that is not confirmed is dead whatever its state, and no limit or alert (24 h, 7 days) still reads it.
const SWEEP_MS = 12 * DAY
const REQUEST_MS = 7 * DAY // a change waits 7 days for its second person
const RELAX_MS = DAY // lowering a security setting can be approved only 24 hours after it was asked
const NO_WAIT_MS = 30 * DAY // the 72 hour wait is for an organisation with no other key-role seat in the last 30 days
const APPROVED_MS = 30 * DAY // the mark of a person Ophis approved lasts 30 days from the approval; then the seat takes the normal rules
const STOP_MS = 7 * DAY // after a completed recovery: the replaced Owner passkeys can stop it, and the organisation is in quarantine
const READY_MS = 7 * DAY // once its wait is over a recovery request can be completed for 7 days; then it has lapsed
const OVERRIDE_MS = 30 * DAY // a green recovery wallet overrides the Owners only this long after one of them cancelled or stopped a request
const MAX_PROOFS = 10 // proof checks per organisation per hour
const KEY_SQL = `('owner', 'admin', 'approver', 'compliance')`
// An Owner seat that a recovery replaced for good: the 7 days in which its passkeys could stop that recovery are over
// and it holds no active passkey. Computed wherever seats are counted or listed (one bound
// value: now); commit() writes it down with the organisation's next write. No scheduled job, no audit row of its own.
const gone = (s: string) => `(${s}.role = 'owner' AND ${s}.state = 'active'
  AND NOT EXISTS (SELECT 1 FROM credentials k WHERE k.org_id = ${s}.org_id AND k.seat_id = ${s}.id AND k.state = 'active')
  AND EXISTS (SELECT 1 FROM credentials k JOIN recovery_requests r ON r.org_id = k.org_id AND r.state = 'completed' AND r.closed_at + ${STOP_MS} = k.stop_right_until
              WHERE k.org_id = ${s}.org_id AND k.seat_id = ${s}.id AND k.state = 'suspended' AND k.stop_right_until <= ?))`
/** Key roles, Owners included: hardware keys unless the organisation allows passkeys that sync (owner, 2026-11-17: an
 * organisation made by an application allows them; an Owner can require hardware keys under Organisation). */
export const needsHardware = (role: Role, syncedKeysAllowed: number) => KEY_ROLES.includes(role) && syncedKeysAllowed !== 1
/** Quarantine and the stop right last 24 hours for a Trader or Viewer, 72 hours for a key role. */
const quarantineMs = (role: Role) => (KEY_ROLES.includes(role) ? 72 : 24) * HOUR
const quarantined = (actor: Actor, now: number) => (actor.quarantineUntil ?? 0) > now
/** Nobody acts on a seat whose role is above their own. */
const mayManage = (actor: Role, target: Role) => actor === 'owner' || (actor === 'admin' && target !== 'owner')

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
// A company's email domain, and a work address at it or at a subdomain of it, in lower case (null otherwise). Ophis
// checks the domain with the company in its review: no list of mail providers. The part before
// the @ is printable ASCII: no control character or bidi override reaches a page or the operator's terminal.
export const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
export function emailAt(value: unknown, domain: string | null) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const host = email.slice(email.lastIndexOf('@') + 1)
  return domain && email.length <= 254 && /^[!-?A-~]{1,64}@[^\s@]+$/.test(email) && DOMAIN.test(host) && (host === domain || host.endsWith(`.${domain}`)) ? email : null
}
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

// G3 (registration): what the operator compares in a review, as one text: every Owner seat with its state, every
// passkey of an Owner seat with its state, the recovery wallet that waits, and (milestone 5b) the sealed declaration. ?1 is the organisation. "Submit for
// review" stores it; commit() below compares it again at the end of every batch of that organisation, whatever the
// write was, and a difference puts the organisation back to "not submitted".
export const REVIEWED = `(SELECT COALESCE(group_concat(x, ' '), '') FROM (
  SELECT s.id || s.state || COALESCE(k.id || k.state, '') AS x FROM seats s LEFT JOIN credentials k ON k.org_id = s.org_id AND k.seat_id = s.id WHERE s.org_id = ?1 AND s.role = 'owner'
  UNION ALL SELECT id FROM wallets WHERE org_id = ?1 AND state = 'pending'
  UNION ALL SELECT id FROM sealed_items WHERE org_id = ?1 AND kind = 'declaration' ORDER BY 1))`

// Writes of one organisation are serialised by the audit sequence: two at the same instant collide on
// the primary key (org_id, seq) and the later one fails whole. So plan() runs after the head is read:
// what it reads is still true when its batch commits, or the batch fails. It returns the audit entry
// and the changes, or null to change nothing.
// ponytail: one retry after a collision, then the caller answers "try again". Ceiling: an organisation
// with many writers at the same instant. Then queue its writes (a Durable Object per organisation).
export async function commit(db: D1Database, orgId: string, plan: () => [Entry, Sql[]] | null | Promise<[Entry, Sql[]] | null>) {
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
      await db.batch([
        db.prepare(`UPDATE seats SET state = 'removed' WHERE org_id = ? AND ${gone('seats')}`).bind(orgId, e.at), ...changes,
        db.prepare(`UPDATE organisations SET review_at = NULL WHERE id = ?1 AND review_at IS NOT NULL AND review_print IS NOT ${REVIEWED}`).bind(orgId), audit,
      ])
      return true
    } catch (error) {
      if (attempt > 0 || !/audit_log\.seq/.test(String((error as Error)?.message))) throw error
    }
  }
}

// The check of the chain, kept per organisation (audit_checks, 0019), so that a load hashes a bounded number of rows at
// any length (Free plan: 10 ms of CPU a request; about 8 us a row in tests/cpu.mjs): at most NEW_ROWS rows after the
// checkpoint, which moves forward only over rows that verified, by compare-and-set on the whole state as read (a load that
// read an older state, or one before a break was stored, writes nothing); and OLD_ROWS older rows from
// recheck_seq, in turn, each window walking on from the hash the window before verified (recheck_hash: a boundary
// row changed between two loads is no anchor), up to the end of a sweep: the checkpoint and its hash as they were when the sweep began, which a
// growing log does not move. The window that reaches that end must end on that hash; the next sweep goes to the
// checkpoint of then. So a row is hashed again within this sweep and the next: ceil(rows / OLD_ROWS) + 1 loads when no
// row is added. A break found is stored, shown on every load after (also by a load that read the state before it and wrote nothing), never
// cleared by code, and replaced by an earlier row only.
// ponytail: a removed tail after the checkpoint, or rows rewritten together with audit_checks, needs the external
// anchor, which is not built.
export const NEW_ROWS = 300
export const OLD_ROWS = 200
export type ChainState = { ok: true; rows: number; head: string; newer: boolean; rechecked: [number, number] | null; per: number } | { ok: false; seq: number }
/** Walks `rows` on from the row (seq, hash): the last row that follows, and the first that does not. */
async function walk(rows: AuditRow[], seq: number, hash: string) {
  for (const row of rows) {
    if (row.seq !== seq + 1 || row.prev_hash !== hash || row.hash !== (await auditHash(row))) return { seq, hash, broken: row.seq }
    ;[seq, hash] = [row.seq, row.hash]
  }
  return { seq, hash, broken: null as number | null }
}
export async function verifyAudit(db: D1Database, orgId: string): Promise<ChainState> {
  const s = (await db.prepare('SELECT checked_seq, checked_hash, recheck_seq, recheck_hash, sweep_seq, sweep_hash, broken_seq FROM audit_checks WHERE org_id = ?').bind(orgId)
    .first<{ checked_seq: number; checked_hash: string; recheck_seq: number; recheck_hash: string; sweep_seq: number; sweep_hash: string; broken_seq: number | null }>())
    ?? { checked_seq: 0, checked_hash: FIRST, recheck_seq: 0, recheck_hash: FIRST, sweep_seq: 0, sweep_hash: FIRST, broken_seq: null }
  if (s.broken_seq !== null) return { ok: false, seq: s.broken_seq }
  const end = Math.min(s.recheck_seq + OLD_ROWS, s.sweep_seq)
  // The rows that exist after the checkpoint, whatever their numbers (a gap is a break, found by walk), and the window.
  const [fresh, old] = (await db.batch<AuditRow>([
    db.prepare('SELECT * FROM audit_log WHERE org_id = ? AND seq > ? ORDER BY seq LIMIT ?').bind(orgId, s.checked_seq, NEW_ROWS + 1),
    db.prepare('SELECT * FROM audit_log WHERE org_id = ? AND seq BETWEEN ? AND ? ORDER BY seq').bind(orgId, s.recheck_seq + 1, end),
  ])).map((r) => r.results)
  // The older rows: on from the stored hash of the window before, to `end`, and there on the sweep's hash.
  const back = await walk(old, s.recheck_seq, s.recheck_hash)
  const oldBroken = back.broken ?? (back.seq < end ? back.seq + 1 : end === s.sweep_seq && back.hash !== s.sweep_hash ? end : null)
  const ahead = await walk(fresh.slice(0, NEW_ROWS), s.checked_seq, s.checked_hash)
  const broken = oldBroken ?? ahead.broken
  const stored = async () => (await db.prepare('SELECT broken_seq FROM audit_checks WHERE org_id = ?').bind(orgId).first<{ broken_seq: number | null }>())?.broken_seq ?? null
  if (broken !== null) {
    const w = await db.prepare(`INSERT INTO audit_checks (org_id, checked_seq, checked_hash, recheck_seq, recheck_hash, sweep_seq, sweep_hash, broken_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (org_id) DO UPDATE SET broken_seq = excluded.broken_seq WHERE broken_seq IS NULL OR broken_seq > excluded.broken_seq`).bind(orgId, s.checked_seq, s.checked_hash, s.recheck_seq, s.recheck_hash, s.sweep_seq, s.sweep_hash, broken).run()
    // Refused: an earlier break is stored, and the page names that one.
    return { ok: false, seq: w.meta.changes ? broken : (await stored()) ?? broken }
  }
  // At the end of a sweep the next one begins, from row 1 to the checkpoint of now.
  const [recheck, sweep] = end === s.sweep_seq ? [{ seq: 0, hash: FIRST }, ahead] : [back, { seq: s.sweep_seq, hash: s.sweep_hash }]
  const moved = (ahead.seq !== s.checked_seq || recheck.seq !== s.recheck_seq || sweep.seq !== s.sweep_seq) && await db.prepare(`INSERT INTO audit_checks (org_id, checked_seq, checked_hash, recheck_seq, recheck_hash, sweep_seq, sweep_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                      ON CONFLICT (org_id) DO UPDATE SET checked_seq = ?2, checked_hash = ?3, recheck_seq = ?4, recheck_hash = ?5, sweep_seq = ?6, sweep_hash = ?7
                      WHERE (checked_seq, checked_hash, recheck_seq, recheck_hash, sweep_seq, sweep_hash) = (?8, ?9, ?10, ?11, ?12, ?13) AND broken_seq IS NULL`)
      .bind(orgId, ahead.seq, ahead.hash, recheck.seq, recheck.hash, sweep.seq, sweep.hash, s.checked_seq, s.checked_hash, s.recheck_seq, s.recheck_hash, s.sweep_seq, s.sweep_hash).run()
  // Nothing written (nothing moved, or refused: another load moved the state or stored a break since this one read it).
  // A stored break is the answer.
  if (!moved || !moved.meta.changes) {
    const b = await stored()
    if (b !== null) return { ok: false, seq: b }
  }
  return { ok: true, rows: ahead.seq, head: ahead.hash, newer: fresh.length > NEW_ROWS, rechecked: end ? [s.recheck_seq + 1, end] : null, per: OLD_ROWS }
}

// ---- before a session exists ----

export interface Ticket { id: string; org_id: string; seat_id: string; kind: string; role: Role; display_name: string; org_name: string; synced_keys_allowed: number }
// The ticket's role must be its seat's role: the key rule (Owners: hardware only) is read from the ticket,
// the rights of the session from the seat, so a ticket that disagrees with its seat is dead.
// A ticket is also dead once the seat that issued it is no longer active (ISSUER_ACTIVE): what a stopped or
// frozen seat had started does not go on without it. (A freeze also closes those tickets in the tables: closeOpen.)
// The first Owner's ticket has no issuer.
const ISSUER_ACTIVE = `(t.issuer_seat_id IS NULL OR EXISTS (SELECT 1 FROM seats i WHERE i.org_id = t.org_id AND i.id = t.issuer_seat_id AND i.state = 'active'))`
export function ticketByToken(db: D1Database, tokenHash: string, now: number) {
  return db
    .prepare(
      `SELECT t.id, t.org_id, t.seat_id, t.kind, t.role, s.display_name, o.name AS org_name, o.synced_keys_allowed
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
  state: 'active' | 'suspended' | 'pending'; stop_right_until: number | null; ticket_id: string | null; seat_state: string; org_state: string
}
/**
 * A passkey of an organisation that is active or not yet verified (milestone 5), with its state. The caller decides what
 * that state may do; a revoked one does not exist here. `closedToo` (G4, the sign-in only): also a passkey of a frozen
 * or archived organisation, so that its member can be told so once the passkey passed its check.
 */
export function credentialById(db: D1Database, credentialId: string, closedToo = false) {
  return db
    .prepare(
      `SELECT c.id, c.org_id, c.seat_id, c.public_key, c.counter, c.state, c.stop_right_until, c.ticket_id, s.state AS seat_state, o.state AS org_state
       FROM credentials c
       JOIN seats s ON s.org_id = c.org_id AND s.id = c.seat_id
       JOIN organisations o ON o.id = c.org_id AND (o.state IN ('unverified', 'active') OR ?2 = 1)
       WHERE c.id = ?1 AND c.state IN ('active', 'suspended', 'pending')`,
    )
    .bind(credentialId, closedToo ? 1 : 0)
    .first<StoredCredential>()
}
/** A replaced passkey keeps one right until quarantine ends: to stop its replacement. A freeze of the seat does not take it away; a seat that is removed has none (also one that a write with a later clock removed 7 days after a recovery, an instant before this stop). */
export const hasStopRight = (c: StoredCredential, now: number) => c.state === 'suspended' && c.seat_state !== 'removed' && (c.stop_right_until ?? 0) > now

// Ends one ticket, with its pending passkey and its waiting confirmation.
const closeTicket = (db: D1Database, orgId: string, ticketId: string, now: number): Sql[] => [
  db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND ticket_id = ? AND state = 'pending'`).bind(orgId, ticketId),
  db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND action = 'ticket.confirm' AND subject_id = ? AND state = 'pending'`).bind(now, orgId, ticketId),
  db.prepare(`UPDATE enrolment_tickets SET state = 'cancelled' WHERE org_id = ? AND id = ?`).bind(orgId, ticketId),
]
// The same for every ticket a seat still has open. Run after the statements that settle the ticket that
// wins, if any: whatever is still open then is dead. `issuedToo`: also the tickets the seat issued for
// others and the changes it asked for, when it is frozen, removed or changes role, so that nothing it
// started goes on without it and unfreezing it later brings none of it back.
function closeOpen(db: D1Database, orgId: string, seatId: string, now: number, issuedToo = false): Sql[] {
  const tickets = `SELECT id FROM enrolment_tickets WHERE org_id = ? AND (seat_id = ? OR (? = 1 AND issuer_seat_id = ?)) AND state IN ('issued', 'stored')`
  const scope = [orgId, orgId, seatId, issuedToo ? 1 : 0, seatId]
  return [
    db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND state = 'pending' AND ticket_id IN (${tickets})`).bind(...scope),
    db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND action = 'ticket.confirm' AND state = 'pending' AND subject_id IN (${tickets})`).bind(now, ...scope),
    db.prepare(`UPDATE enrolment_tickets SET state = 'dead' WHERE org_id = ? AND id IN (${tickets})`).bind(...scope),
    db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND requester_seat_id = ? AND state = 'pending' AND ? = 1`).bind(now, orgId, seatId, issuedToo ? 1 : 0),
    // The real desk: the signing links the seat gave, and those of the orders it prepared, die; the approved orders it prepared
    // that are not sent are withdrawn. One whose send holds its id finishes: withdrawn if the orderbook does not take it (orderUnsent).
    db.prepare(`UPDATE orders SET link_hash = NULL, link_purpose = NULL WHERE org_id = ? AND link_purpose = 'sign' AND ? = 1
                AND (link_by = ? OR id IN (SELECT id FROM approvals WHERE org_id = ? AND requester_seat_id = ? AND action = 'order'))`).bind(orgId, issuedToo ? 1 : 0, seatId, orgId, seatId),
    db.prepare(`UPDATE orders SET status = 'cancelled', link_hash = NULL, link_purpose = NULL WHERE org_id = ? AND uid IS NULL AND status IS NULL AND ? = 1
                AND id IN (SELECT id FROM approvals WHERE org_id = ? AND requester_seat_id = ? AND action = 'order')`).bind(orgId, issuedToo ? 1 : 0, orgId, seatId),
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
  role: Role; display_name: string; quarantine_until: number | null; org_quarantine_until: number | null; org_name: string; org_kind: string; synced_keys_allowed: number
  /** Active passkeys of the seat; for an Owner, the device-bound ones only. Two are needed before anything sensitive. */
  strong_keys: number
  /** Milestone 5: read with the session, judged by the router. Unverified: the routes marked so. Frozen or archived: the sign-out. */
  org_state: 'unverified' | 'active' | 'frozen' | 'archived'
}
/** A session that is not revoked, whose passkey and seat are still active. The caller checks the time limits and the organisation's state. */
export function sessionByToken(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT x.id, x.org_id, x.seat_id, x.credential_id, x.created_at, x.last_seen_at, x.step_up_at, s.role, s.display_name, s.quarantine_until, o.quarantine_until AS org_quarantine_until,
              o.name AS org_name, o.kind AS org_kind, o.synced_keys_allowed, o.state AS org_state,
              (SELECT count(*) FROM credentials k WHERE k.org_id = x.org_id AND k.seat_id = x.seat_id AND k.state = 'active' AND (s.role <> 'owner' OR k.device_bound = 1 OR o.synced_keys_allowed = 1)) AS strong_keys
       FROM sessions x
       JOIN credentials c ON c.org_id = x.org_id AND c.id = x.credential_id AND c.state = 'active'
       JOIN seats s ON s.org_id = x.org_id AND s.id = x.seat_id AND s.state = 'active'
       JOIN organisations o ON o.id = x.org_id
       WHERE x.token_hash = ? AND x.revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<Session>()
}

// ---- for a signed-in member: the organisation comes from the Actor ----

/** A write with no audit row (the other is countProof): it only moves the idle clock. */
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
export async function organisationView(db: D1Database, actor: Actor, now: number, idleSince: number, startedSince: number) {
  const scope = [actor.orgId, seesAll(actor), actor.seatId]
  const [members, passkeys, sessions] = await db.batch([
    db.prepare(`SELECT id, display_name AS displayName, role, CASE WHEN ${gone('seats')} THEN 'removed' ELSE state END AS state, (ophis_approved AND created_at > ?) AS approved FROM seats WHERE org_id = ? AND (? = 1 OR id = ?) ORDER BY created_at, id`).bind(now, now - APPROVED_MS, ...scope),
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

const seatEntry = (actor: Actor, now: number, action: string, subjectId: string | null, detail: string | null = null): Entry =>
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
    if (!(await roleNow(db, actor)) || (await seatCredentialIds(db, actor, true)).length >= MAX_PASSKEYS) return null
    return [seatEntry(actor, now, 'credential.add', credential.id), [
      db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
        .bind(credential.id, actor.orgId, actor.seatId, credential.publicKey, credential.counter, credential.deviceBound ? 1 : 0, JSON.stringify(credential.transports), label, now),
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND seat_id = ? AND id <> ? AND revoked_at IS NULL').bind(now, actor.orgId, actor.seatId, actor.sessionId),
    ]]
  })
}

/** Active passkeys of active seats only: a replaced (suspended) one keeps its stop right, and a frozen seat waits for two people. */
export async function revokeCredential(db: D1Database, session: Actor, credentialId: string, now: number) {
  let outcome: 'ok' | 'not_found' | 'forbidden' | 'quarantine' | 'last_passkey' = 'not_found'
  await commit(db, session.orgId, async () => {
    const actor = await actorNow(db, session)
    outcome = 'not_found' // a second run of the plan starts again
    if (!actor) return null
    const c = await db
      .prepare(`SELECT c.seat_id, s.role, (SELECT count(*) FROM credentials k WHERE k.org_id = c.org_id AND k.seat_id = c.seat_id AND k.state = 'active') AS active
                FROM credentials c JOIN seats s ON s.org_id = c.org_id AND s.id = c.seat_id AND s.state = 'active'
                WHERE c.org_id = ? AND c.id = ? AND c.state = 'active' AND (c.seat_id = ? OR ? = 1)`)
      .bind(actor.orgId, credentialId, actor.seatId, seesAll(actor)).first<{ seat_id: string; role: Role; active: number }>()
    // The last passkey of a seat is never revoked, by anyone: a colleague who took it would leave the member
    // nothing to stop a replacement with. In an emergency the seat is frozen (one person); lost passkeys are
    // replaced by a re-enrolment.
    outcome = !c ? 'not_found'
      : c.seat_id !== actor.seatId && !mayManage(actor.role, c.role) ? 'forbidden'
      : c.seat_id !== actor.seatId && quarantined(actor, now) ? 'quarantine'
      : c.active < 2 ? 'last_passkey'
      : 'ok'
    if (outcome !== 'ok') return null
    return [seatEntry(actor, now, 'credential.revoke', credentialId), [db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND id = ?`).bind(actor.orgId, credentialId)]]
  })
  return outcome as 'ok' | 'not_found' | 'forbidden' | 'quarantine' | 'last_passkey' // the plan assigns it; the compiler cannot see that
}

// ---- enrolment tickets and their confirmation (recovery.md section 2) ----

type Target = { seatId: string } | { displayName: string; role: Role }
/** An invitation (a new seat, or a seat that never enrolled) or the re-enrolment of an active seat. The seat decides which. */
export async function issueTicket(db: D1Database, session: Actor, target: Target, tokenHash: string, now: number) {
  const ticketId = randomId()
  const newSeatId = randomId()
  type Issued = { error: 'not_found' | 'forbidden' | 'quarantine' | 'ticket_limit' } | { error?: undefined; ticketId: string; seatId: string; kind: string; role: Role; expiresAt: number }
  let outcome: Issued = { error: 'not_found' }
  await commit(db, session.orgId, async () => {
    const actor = await actorNow(db, session)
    outcome = { error: actor ? 'not_found' : 'forbidden' } // a second run of the plan starts again
    if (!actor) return null
    let seat: { id: string; role: Role; state: string } | null = 'seatId' in target ? null : { id: newSeatId, role: target.role, state: 'new' }
    // A member does not re-enrol their own seat: they add a passkey after a check from one they hold.
    if ('seatId' in target && target.seatId !== actor.seatId) {
      seat = await db.prepare(`SELECT id, role, state FROM seats WHERE org_id = ? AND id = ? AND state IN ('invited', 'active')`).bind(actor.orgId, target.seatId).first<{ id: string; role: Role; state: string }>()
    }
    // The seat a recovery request made is not a colleague's to enrol on: only the request's own passkey ever sits on it.
    if (!seat || (seat.state === 'invited' && (await recoveryRow(db, actor.orgId, now, 'seat_id', seat.id)))) return null
    const kind = seat.state === 'active' ? 're_enrolment' : 'invitation'
    const issued = await db.prepare('SELECT count(*) AS n FROM enrolment_tickets WHERE org_id = ? AND issuer_seat_id = ? AND seat_id = ? AND created_at > ?')
      .bind(actor.orgId, actor.seatId, seat.id, now - 24 * HOUR).first<{ n: number }>()
    // No limit on new members (owner decision of 2026-11-13): an Owner or Admin adds as many as needed.
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
      db.prepare(`INSERT INTO enrolment_tickets (id, org_id, seat_id, kind, role, issuer_seat_id, token_hash, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`)
        .bind(ticketId, actor.orgId, seat.id, kind, seat.role, actor.seatId, tokenHash, expiresAt, now),
      // The sweep: tickets that were never confirmed, and the pending passkeys stored on them, once nothing reads them.
      db.prepare(`DELETE FROM credentials WHERE org_id = ? AND ticket_id IN (SELECT id FROM enrolment_tickets WHERE org_id = ? AND state <> 'confirmed' AND created_at < ?)`).bind(actor.orgId, actor.orgId, now - SWEEP_MS),
      db.prepare(`DELETE FROM enrolment_tickets WHERE org_id = ? AND state <> 'confirmed' AND created_at < ?`).bind(actor.orgId, now - SWEEP_MS),
    ]]
  })
  return outcome as Issued
}

export interface OpenTicket {
  id: string; kind: 'first_owner' | 'invitation' | 're_enrolment'; role: Role; state: string; seat_id: string; issuer_seat_id: string | null; display_name: string
  expires_at: number; stored_at: number | null
  credential_id: string | null; public_key: string | null; approval_id: string | null; not_before: number | null; approval_expires_at: number | null
  /** 1: Ophis approved this person with the organisation (the seat's mark, on an invited seat only, for 30 days from the approval). */
  approved: number
  /** link: waits for the member's passkey. issuer: waits for the issuer's confirmation. second: for a second person's. wait: for the 72 hours. */
  status: 'link' | 'issuer' | 'second' | 'wait'
  /** What the viewer may do now. */
  myStep: 'issuer' | 'second' | null
  until: number
}
// Every open ticket of the organisation that is still alive, with the step the viewer may take. A ticket
// whose seat or issuer is not in the right state, or whose time is up, is not here: it is dead without a write.
// openTickets() below is the only shape that leaves the server.
async function ticketRows(db: D1Database, viewer: Pick<Actor, 'orgId' | 'seatId' | 'role'>, now: number, ticketId: string | null = null) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.kind, t.role, t.state, t.seat_id, t.issuer_seat_id, s.display_name, t.expires_at, t.stored_at, (s.ophis_approved AND s.created_at > ?) AS approved,
              c.id AS credential_id, c.public_key, a.id AS approval_id, a.not_before, a.expires_at AS approval_expires_at
       FROM enrolment_tickets t
       JOIN seats s ON s.org_id = t.org_id AND s.id = t.seat_id AND s.role = t.role AND s.state = CASE t.kind WHEN 're_enrolment' THEN 'active' ELSE 'invited' END
       LEFT JOIN credentials c ON c.org_id = t.org_id AND c.ticket_id = t.id AND c.state = 'pending'
       LEFT JOIN approvals a ON a.org_id = t.org_id AND a.subject_id = t.id AND a.action = 'ticket.confirm' AND a.state = 'pending'
       WHERE t.org_id = ? AND t.state IN ('issued', 'stored') AND (? IS NULL OR t.id = ?) AND ${ISSUER_ACTIVE}
       ORDER BY t.created_at, t.id`,
    )
    .bind(now - APPROVED_MS, viewer.orgId, ticketId, ticketId)
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

/** For the "Waiting for confirmation" list. An Owner or Admin sees every open ticket; anyone else only those waiting for their step. No secret field. */
export async function openTickets(db: D1Database, actor: Actor, now: number) {
  return (await ticketRows(db, actor, now))
    .filter((t) => seesAll(actor) === 1 || t.myStep)
    .map((t) => ({
      id: t.id, kind: t.kind, role: t.role, seatId: t.seat_id, name: t.display_name, issuerSeatId: t.issuer_seat_id, status: t.status, myStep: t.myStep, until: t.until,
      storedAt: t.stored_at, // when the member created the pending passkey, for the confirmation card
      approved: t.approved, // 1: Ophis approved this person, so the issuer's confirmation is the only one (the card says so)
    }))
}
/** The ticket, if the member may confirm it now. */
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
    // The mark of a person Ophis approved is good once: the first activation uses it up (0015 refuses it on an active seat).
    db.prepare(`UPDATE seats SET state = 'active', quarantine_until = ?, ophis_approved = 0 WHERE org_id = ? AND id = ?`).bind(until, orgId, t.seat_id),
    db.prepare(`UPDATE enrolment_tickets SET state = 'confirmed' WHERE org_id = ? AND id = ?`).bind(orgId, t.id),
    db.prepare(`UPDATE approvals SET state = 'applied', checker_seat_id = ?, decided_at = ? WHERE org_id = ? AND id = ?`).bind(checkerSeatId, now, orgId, t.approval_id),
    ...closeOpen(db, orgId, t.seat_id, now),
  ]
}

/** The 30 day predicate: no seat but this one is, or in the last 30 days was, a key-role seat. Only then does one person stand for two. */
const alone = async (db: D1Database, orgId: string, seatId: string, now: number) =>
  !(await db.prepare(
    `SELECT count(*) AS n FROM seats s WHERE s.org_id = ? AND s.id <> ? AND (
       (s.role IN ${KEY_SQL} AND ((s.state IN ('active', 'frozen') AND NOT ${gone('s')}) OR (s.state = 'removed' AND EXISTS
         (SELECT 1 FROM audit_log a WHERE a.org_id = s.org_id AND a.subject_id = s.id AND a.action = 'seat.remove' AND a.detail IS NULL AND a.at > ?))))
       OR EXISTS (SELECT 1 FROM audit_log a WHERE a.org_id = s.org_id AND a.subject_id = s.id AND a.action = 'seat.role' AND a.at > ?))`,
  ).bind(orgId, seatId, now, now - NO_WAIT_MS, now - NO_WAIT_MS).first<{ n: number }>())!.n

type Confirmed = { state: 'active' | 'second' | 'gone' } | { state: 'wait'; waitUntil: number }
/** The passkey check made for this ticket passed. `seen` is the ticket as the check saw it: read again here, it must still wait for this member's step, else nothing is written. */
export async function confirmTicket(db: D1Database, session: Actor, seen: OpenTicket, x: { credentialHash: string; credentialId: string; counter: number; now: number }) {
  let outcome: Confirmed = { state: 'gone' }
  const { now } = x
  await commit(db, session.orgId, async () => {
    const actor = await actorNow(db, session)
    const t = actor && (await ticketToConfirm(db, actor, seen.id, now))
    outcome = { state: 'gone' }
    if (!actor || !t) return null
    const check = used(db, actor.orgId, x.credentialId, x.counter, now)
    // A seat Ophis approved with the organisation (owner decision of 2026-11-13): at its first enrolment the issuer's
    // confirmation is enough, with no second person and no wait. The mark exists only on an invited seat that the
    // operator's approval made, and the activation below clears it: a re-enrolment, or a member invited by a colleague, never has it.
    if (t.myStep === 'issuer' && KEY_ROLES.includes(t.role) && !t.approved) {
      // The 72 hour wait stands in for the second person only in an organisation that has had no key-role seat but
      // the issuer's in the last 30 days: active, frozen, removed, or lowered from a key role (the audit rows give
      // the dates). Otherwise one Owner could freeze or remove every colleague and then pass every two-person rule
      // alone after a wait. A re-enrolled key-role member is such a seat: their seat never comes back by a wait.
      // A role changed in those 30 days counts whatever the role was: the change took two key-role people.
      const waitUntil = (await alone(db, actor.orgId, actor.seatId, now)) ? now + WAIT_MS : null
      outcome = waitUntil === null ? { state: 'second' } : { state: 'wait', waitUntil }
      return [seatEntry(actor, now, 'ticket.confirm', t.id, waitUntil === null ? 'second' : 'wait'), [
        check,
        // approvals has CHECK (checker <> requester): the issuer can never be recorded as the second person.
        db.prepare(`INSERT INTO approvals (id, org_id, action, subject_id, payload_hash, requester_seat_id, state, not_before, expires_at, created_at) VALUES (?, ?, 'ticket.confirm', ?, ?, ?, 'pending', ?, ?, ?)`)
          .bind(randomId(), actor.orgId, t.id, x.credentialHash, actor.seatId, waitUntil, waitUntil === null ? t.stored_at! + CONFIRM_MS : waitUntil + WAIT_OPEN_MS, now),
      ]]
    }
    outcome = { state: 'active' }
    return [seatEntry(actor, now, 'credential.activate', t.credential_id!, t.approved ? 'ophis' : t.myStep), [check, ...activation(db, actor.orgId, t, now, t.myStep === 'second' ? actor.seatId : null)]]
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

/** Any ticket that is still open, with its pending passkey and its waiting confirmation. An Owner's right, checked again at the moment of the write. */
export function cancelTicket(db: D1Database, actor: Actor, ticketId: string, now: number) {
  return commit(db, actor.orgId, async () => {
    const t = await db.prepare(`SELECT id FROM enrolment_tickets WHERE org_id = ? AND id = ? AND state IN ('issued', 'stored')`).bind(actor.orgId, ticketId).first()
    if (!t || (await roleNow(db, actor)) !== 'owner') return null
    return [seatEntry(actor, now, 'ticket.cancel', ticketId), closeTicket(db, actor.orgId, ticketId, now)]
  })
}

// The stop right (recovery.md section 1): the replacement and everything it added is revoked, the replaced
// passkeys are active again, and the seat is frozen until two people unfreeze it. After two re-enrolments
// inside one quarantine, the stopping passkey and the ones replaced before it come back; every passkey
// added after it was replaced is revoked, whether it is the active one or was itself replaced since. On a seat
// that a colleague froze meanwhile, the replacement is among the passkeys the freeze suspended (no stop right
// date): revoked too, so that the unfreeze cannot bring it back.
export function stopReplacement(db: D1Database, credential: StoredCredential, counter: number, now: number) {
  const { org_id: orgId, seat_id: seatId } = credential
  return commit(db, orgId, async () => {
    const current = await credentialById(db, credential.id)
    if (!current || !hasStopRight(current, now)) return null
    // A passkey that a completed recovery replaced stops that recovery, not a re-enrolment of its own seat: the new
    // Owner seat goes, with every passkey on it; the Owner passkeys the completion suspended (they carry its date) are
    // active again; the organisation quarantine ends; the recovery wallet is as the completion found it. No seat is frozen.
    const recovered = await recoveryToStop(db, current)
    if (recovered) {
      // Every enrolment made under the recovery is rolled back, in the order it was made: a passkey activated on a link
      // whose issuer, or whose last confirmer, is a seat under the recovery puts its own seat under it, until the stop.
      // (Only re-enrolments: the organisation quarantine lets nobody join.) On such a seat the passkey of each such link
      // goes, with what its holder added until the next link replaced it. If the last link of the seat is such a link,
      // the passkeys that the run of them replaced (they carry the date of its first) are active again, whether or not
      // their own stop right has ended; after a link nobody under the recovery touched, that link's passkey stands.
      // What the seat opened is closed.
      const made = (await db.prepare(`SELECT a.at, a.actor_id AS by, k.id, k.seat_id AS seat, t.issuer_seat_id AS issuer, t.role
                                      FROM audit_log a JOIN credentials k ON k.org_id = a.org_id AND k.id = a.subject_id JOIN enrolment_tickets t ON t.org_id = k.org_id AND t.id = k.ticket_id
                                      WHERE a.org_id = ? AND a.action = 'credential.activate' AND a.at >= ? ORDER BY a.seq`)
        .bind(orgId, recovered.closed_at).all<{ at: number; by: string; id: string; seat: string; issuer: string; role: Role }>()).results
      const under = new Set([recovered.seat_id])
      const links = new Map<string, { at: number; id: string; role: Role; bad: boolean }[]>()
      for (const e of made) {
        const bad = under.has(e.issuer) || under.has(e.by)
        if (bad) under.add(e.seat)
        links.set(e.seat, [...(links.get(e.seat) ?? []), { ...e, bad }])
      }
      under.delete(recovered.seat_id)
      const rollback = [...under].flatMap((seat) => {
        const of = links.get(seat)!
        const first = of.findLastIndex((e) => !e.bad) + 1
        // INDEXED BY: for the OR, SQLite would read every passkey with no ticket, of every organisation (the rows of D1 Free).
        return [
          ...of.flatMap((e, i) => (!e.bad ? [] : [db.prepare(`UPDATE credentials INDEXED BY credentials_by_seat SET state = 'revoked' WHERE org_id = ? AND seat_id = ? AND state <> 'revoked' AND (id = ? OR (ticket_id IS NULL AND created_at >= ? AND created_at < ?))`)
            .bind(orgId, seat, e.id, e.at, of[i + 1]?.at ?? Number.MAX_SAFE_INTEGER)])),
          ...(first === of.length ? [] : [db.prepare(`UPDATE credentials SET state = 'active', stop_right_until = NULL WHERE org_id = ? AND seat_id = ? AND state = 'suspended' AND stop_right_until = ?`)
            .bind(orgId, seat, of[first].at + quarantineMs(of[first].role))]),
          ...closeOpen(db, orgId, seat, now, true),
        ]
      })
      const wallets = recovered.undo === null ? null : (JSON.parse(recovered.undo) as { id: string; anchor: string; at: number | null }[])
      return [{ at: now, actorKind: 'seat', actorId: seatId, sessionId: null, action: 'recovery.stop', subjectId: recovered.id }, [
        db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND seat_id = ? AND state <> 'revoked'`).bind(orgId, recovered.seat_id),
        db.prepare(`UPDATE seats SET state = 'removed' WHERE org_id = ? AND id = ?`).bind(orgId, recovered.seat_id),
        ...rollback,
        // Every session a revoked passkey opened ends, on the re-enrolled seats too: a write of theirs that is under way finds no session in its commit.
        db.prepare(`UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND revoked_at IS NULL AND credential_id IN (SELECT id FROM credentials WHERE org_id = ? AND state = 'revoked')`).bind(now, orgId, orgId),
        ...closeOpen(db, orgId, recovered.seat_id, now, true),
        db.prepare(`UPDATE credentials SET state = 'active', stop_right_until = NULL WHERE org_id = ? AND state = 'suspended' AND stop_right_until = ? AND seat_id IN (SELECT id FROM seats WHERE org_id = ? AND role = 'owner')`).bind(orgId, current.stop_right_until, orgId),
        used(db, orgId, credential.id, counter, now),
        db.prepare('UPDATE organisations SET quarantine_until = NULL WHERE id = ?').bind(orgId),
        // The wallet that waited is linked again if the new Owner unlinked it (nothing is linked during the quarantine, so its address is still free).
        ...(wallets === null ? [] : [
          db.prepare('UPDATE wallets SET anchor = NULL, anchor_effective_at = NULL WHERE org_id = ? AND anchor IS NOT NULL').bind(orgId),
          // Sanctions screening: a wallet the new Owner unlinked stays unlinked when its address came onto a loaded list since. One that
          // is still linked keeps its place as the recovery wallet (linked to linked meets no trigger). The stop itself is never refused.
          ...wallets.map((w) => db.prepare(`UPDATE wallets SET state = 'linked', anchor = ?, anchor_effective_at = ? WHERE org_id = ? AND id = ?
                                            AND (state = 'linked' OR address NOT IN (SELECT address FROM sanctioned_addresses))`).bind(w.anchor, w.at, orgId, w.id)),
        ]),
      ]]
    }
    return [{ at: now, actorKind: 'seat', actorId: seatId, sessionId: null, action: 'credential.stop', subjectId: credential.id }, [
      db.prepare(`UPDATE credentials SET state = CASE WHEN state = 'suspended' AND stop_right_until <= ? THEN 'active' ELSE 'revoked' END, stop_right_until = NULL
                  WHERE org_id = ? AND seat_id = ? AND (state = 'active' OR (state = 'suspended' AND (stop_right_until IS NULL OR stop_right_until > ?)))`).bind(current.stop_right_until, orgId, seatId, now),
      used(db, orgId, credential.id, counter, now),
      db.prepare(`UPDATE seats SET state = 'frozen', quarantine_until = NULL WHERE org_id = ? AND id = ?`).bind(orgId, seatId),
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND seat_id = ? AND revoked_at IS NULL').bind(now, orgId, seatId),
      ...closeOpen(db, orgId, seatId, now, true),
    ]]
  })
}

// ---- milestone 3: one person freezes, two people change ----

export type Kind = 'seat.unfreeze' | 'seat.remove' | 'seat.role' | 'policy.synced_keys' | 'wallet.link' | 'anchor.set' | 'order'
/** Changes one person makes: each only tightens, or undoes what has not taken effect yet. */
export type Direct = 'seat.freeze' | 'wallet.unlink' | 'anchor.cancel'
// The actor's role as it is inside the commit. The session's copy was read before this write took its turn: a
// member lowered, frozen or removed at the same instant must not act with the role they had. Null: the seat is
// not active, or the session has ended since (a role change, a freeze, a re-enrolment and a revoke all end it).
const roleNow = async (db: D1Database, actor: Actor) =>
  (await db.prepare(`SELECT s.role FROM seats s JOIN sessions x ON x.org_id = s.org_id AND x.seat_id = s.id AND x.id = ? AND x.revoked_at IS NULL
                     WHERE s.org_id = ? AND s.id = ? AND s.state = 'active'`).bind(actor.sessionId, actor.orgId, actor.seatId).first<{ role: Role }>())?.role ?? null
/** The actor with the role of this moment, for the plans of the milestone 2 writes. Null: the seat is no longer active. */
const actorNow = async (db: D1Database, actor: Actor) => {
  const role = await roleNow(db, actor)
  return role ? { ...actor, role } : null
}
interface Change { apply: Sql[]; detail: string | null; direct?: boolean; relax?: boolean }
// One change, judged against the rows as they are now, for a requester with this role. It runs inside the commit
// that files the request and again inside the commit that applies it, so an approval never applies what has
// become forbidden since. `direct`: one person is enough (a freeze only tightens; an invited seat was never a member).
// `by` is the seat that asks. `snapshot`: the Safe as both endpoints see it now, read by the caller before the commit.
async function judge(db: D1Database, orgId: string, role: Role, kind: Kind | Direct, subjectId: string, value: string | null, now: number, by: string, snapshot: string | null): Promise<string | Change> {
  if (kind === 'order') {
    // An order of the desk (orders.ts). The value is its terms, complete: chain, wallet, both tokens, the exact amount
    // sold, the least amount bought, validity, appData and fee. Everything that decides it is read here, when it is filed
    // and again when it is approved: the terms are what this server makes of their own inputs now (an asset, a cap, an
    // appData or a fee it would not make is refused), the organisation (active, of either kind since 2026-11-19, not in quarantine), the
    // preparer (`by`: an active seat whose role may prepare, now), the wallet (this organisation's, linked, with this name,
    // address and kind, on the chain of the order) and the number of orders that wait. The approval makes its order row.
    const terms = again(value)
    if (typeof terms === 'string') return terms
    if (JSON.stringify(terms) !== value) return 'invalid'
    const r = await db.prepare(`SELECT s.role, max(COALESCE(s.quarantine_until, 0), COALESCE(o.quarantine_until, 0)) AS quarantine,
                                  (SELECT w.label FROM wallets w WHERE w.org_id = o.id AND w.id = ?1 AND w.state = 'linked') AS wallet, (SELECT w.address FROM wallets w WHERE w.org_id = o.id AND w.id = ?1) AS address,
                                  (SELECT w.chain_id FROM wallets w WHERE w.org_id = o.id AND w.id = ?1) AS chain, (SELECT w.kind FROM wallets w WHERE w.org_id = o.id AND w.id = ?1) AS walletKind, (SELECT w.proof_by FROM wallets w WHERE w.org_id = o.id AND w.id = ?1) AS proofBy,
                                  (SELECT count(*) FROM approvals a WHERE a.org_id = o.id AND a.action = 'order' AND a.subject_id <> ?2 AND a.state = 'pending' AND a.expires_at > ?3) AS waiting
                                FROM organisations o LEFT JOIN seats s ON s.org_id = o.id AND s.id = ?4 AND s.state = 'active' WHERE o.id = ?5 AND o.state = 'active'`)
      .bind(terms.walletId, subjectId, now, by, orgId).first<{ role: Role | null; quarantine: number; wallet: string | null; address: string | null; chain: number | null; walletKind: string | null; proofBy: string | null; waiting: number }>()
    return !r ? 'org_inactive'
      : !r.role || !(PREPARERS as readonly Role[]).includes(r.role) ? 'forbidden'
      : r.quarantine > now ? 'quarantine'
      : r.wallet === null || r.wallet !== terms.label || checksum(r.address!) !== terms.wallet || (r.walletKind === 'safe') !== (terms.scheme === 'presign') ? 'wallet_not_linked'
      : r.chain !== terms.chainId ? 'wallet_chain'
      : r.walletKind !== 'safe' && r.proofBy === 'contract' ? 'wallet_contract'
      : r.waiting >= MAX_OPEN_ORDERS ? 'too_many_orders'
      : { detail: null, apply: [db.prepare(`INSERT INTO orders (org_id, id, approved_at) SELECT org_id, id, ? FROM approvals WHERE org_id = ? AND subject_id = ? AND action = 'order'`).bind(now, orgId, subjectId)] }
  }
  if (kind === 'wallet.link' || kind === 'wallet.unlink' || kind === 'anchor.set' || kind === 'anchor.cancel') {
    const at = [orgId, subjectId] as const
    const w = await db.prepare('SELECT state, kind, address FROM wallets WHERE org_id = ? AND id = ?').bind(...at).first<{ state: string; kind: string; address: string }>()
    if (!w || w.state !== (kind === 'wallet.link' ? 'pending' : 'linked')) return 'not_found'
    // Wallets are linked and unlinked by an Owner or Admin. The recovery wallet is an Owner's matter.
    if (role !== 'owner' && (role !== 'admin' || kind === 'anchor.set' || kind === 'anchor.cancel')) return 'forbidden'
    if (kind === 'wallet.link') return (await listed(db, w.address)) ? 'wallet_listed' : { detail: null, apply: [db.prepare(`UPDATE wallets SET state = 'linked', linked_at = ? WHERE org_id = ? AND id = ? AND state = 'pending'`).bind(now, ...at)] }
    const a = await anchors(db, orgId, now)
    if (kind === 'wallet.unlink') {
      // Never the recovery wallet, in force or waiting: the last resort is replaced first, by two people and 72 hours.
      // Nor the wallet that signed a recovery request which is still open: it was in force then, and is again at the completion.
      if (subjectId === a.inForce || subjectId === a.waiting || (await recoveryRow(db, orgId, now))?.wallet_id === subjectId) return 'recovery_wallet'
      return { direct: true, detail: null, apply: [
        ...promote(db, orgId, now),
        db.prepare(`UPDATE wallets SET state = 'unlinked' WHERE org_id = ? AND id = ?`).bind(...at),
        db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND subject_id = ? AND state = 'pending'`).bind(now, ...at),
      ] }
    }
    if (kind === 'anchor.cancel') {
      if (subjectId !== a.waiting) return 'not_found' // after its 72 hours it is in force: it is replaced, not cancelled
      return { direct: true, detail: null, apply: [db.prepare(`UPDATE wallets SET anchor = NULL, anchor_effective_at = NULL WHERE org_id = ? AND id = ? AND anchor = 'next'`).bind(...at)] }
    }
    if (a.waiting) return 'change_waiting' // one change at a time: an Owner cancels the one that waits first
    if (subjectId === a.inForce) return 'invalid'
    // One person is enough only where the 72 hour wait stands for the second person (the 30 day rule). A single key
    // is a recovery wallet only there: with colleagues, one key would outrank them all.
    const direct = await alone(db, orgId, by, now)
    if (w.kind === 'single_key' && !direct) return 'single_key'
    if (w.kind === 'safe' && !snapshot) return 'wallet_unreadable'
    // In force 72 hours from now. Until then the one in force stays, and any Owner can cancel.
    return { direct, detail: direct ? 'alone' : null, apply: [
      ...promote(db, orgId, now),
      db.prepare(`UPDATE wallets SET anchor = 'next', anchor_effective_at = ?, snapshot = COALESCE(?, snapshot) WHERE org_id = ? AND id = ?`).bind(now + WAIT_MS, snapshot, ...at),
    ] }
  }
  if (kind === 'policy.synced_keys') {
    const org = await db.prepare('SELECT synced_keys_allowed AS allowed FROM organisations WHERE id = ?').bind(orgId).first<{ allowed: number }>()
    if ((value !== '0' && value !== '1') || Number(value) === org!.allowed) return 'invalid'
    if (role !== 'owner') return 'forbidden'
    return { apply: [db.prepare('UPDATE organisations SET synced_keys_allowed = ? WHERE id = ?').bind(Number(value), orgId)], detail: value === '1' ? 'synced' : 'hardware', relax: value === '1' }
  }
  const seat = await db
    .prepare(`SELECT s.role, s.state, s.quarantine_until AS quarantine, o.synced_keys_allowed AS synced,
                (SELECT count(*) FROM seats x WHERE x.org_id = s.org_id AND x.id <> s.id AND x.role = 'owner' AND x.state = 'active' AND NOT ${gone('x')}) AS owners,
                (SELECT count(*) FROM credentials k WHERE k.org_id = s.org_id AND k.seat_id = s.id AND k.state = 'active' AND k.device_bound = 0) AS soft
              FROM seats s JOIN organisations o ON o.id = s.org_id WHERE s.org_id = ? AND s.id = ? AND s.state <> 'removed' AND NOT ${gone('s')}`)
    .bind(now, orgId, subjectId, now).first<{ role: Role; state: string; quarantine: number | null; synced: number; owners: number; soft: number }>()
  // The seat of an open recovery request is nobody's to remove: that would cancel the request, which an Owner may
  // only do through the cancel route, and never for an override.
  if (!seat || (seat.state === 'invited' && (await recoveryRow(db, orgId, now, 'seat_id', subjectId)))) return 'not_found'
  if (!mayManage(role, seat.role)) return 'forbidden'
  // The last Owner is never frozen, removed or lowered: nobody would be left who can manage the organisation.
  const lastOwner = seat.role === 'owner' && seat.state === 'active' && seat.owners === 0
  const at = [orgId, subjectId] as const
  const setSeat = (column: 'state' | 'role', to: string) => db.prepare(`UPDATE seats SET ${column} = ? WHERE org_id = ? AND id = ?`).bind(to, ...at)
  const endSessions = db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND seat_id = ? AND revoked_at IS NULL').bind(now, ...at)
  if (kind === 'seat.freeze') {
    if (seat.state !== 'active') return 'not_found'
    if (lastOwner) return 'last_owner'
    return { direct: true, detail: null, apply: [
      setSeat('state', 'frozen'),
      // Suspended, not revoked, and with no stop right: the unfreeze gives exactly these back.
      db.prepare(`UPDATE credentials SET state = 'suspended' WHERE org_id = ? AND seat_id = ? AND state = 'active'`).bind(...at),
      endSessions, ...closeOpen(db, orgId, subjectId, now, true),
    ] }
  }
  if (kind === 'seat.unfreeze') {
    if (seat.state !== 'frozen') return 'not_found'
    // The passkeys that were active before the freeze stand. What a stop revoked stays revoked, and a passkey
    // that was replaced before the freeze stays suspended (it has a stop right date; a frozen one has none).
    return { detail: null, apply: [setSeat('state', 'active'), db.prepare(`UPDATE credentials SET state = 'active' WHERE org_id = ? AND seat_id = ? AND state = 'suspended' AND stop_right_until IS NULL`).bind(...at)] }
  }
  if (kind === 'seat.remove') {
    if (lastOwner) return 'last_owner'
    return { direct: seat.state === 'invited', detail: seat.state === 'invited' ? 'invited' : null, apply: [
      setSeat('state', 'removed'),
      db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND seat_id = ? AND state <> 'revoked'`).bind(...at),
      endSessions, ...closeOpen(db, orgId, subjectId, now, true),
      db.prepare(`UPDATE approvals SET state = 'cancelled', decided_at = ? WHERE org_id = ? AND subject_id = ? AND state = 'pending'`).bind(now, ...at),
    ] }
  }
  const to = value as Role
  if (seat.state !== 'active' || !ROLES.includes(to) || to === seat.role) return 'invalid'
  if (!mayManage(role, to)) return 'forbidden' // never above the requester's own role
  // While a re-enrolment of the seat can still be stopped, the passkey on it may be an issuer's own: a promotion would
  // give that issuer a second key-role seat. A lowered role would also shorten the stop right of the next replacement.
  if ((seat.quarantine ?? 0) > now) return 'seat_in_quarantine'
  if (lastOwner) return 'last_owner'
  if (needsHardware(to, seat.synced) && seat.soft > 0) return 'device_bound_required'
  // The sessions end: the new role starts at the next sign-in. What the seat issued or asked for under the old role is closed.
  return { detail: `${seat.role}.${to}`, apply: [setSeat('role', to), endSessions, ...closeOpen(db, orgId, subjectId, now, true)] }
}

type Changed = { error: string } | { state: 'applied' } | { state: 'requested'; id: string; notBefore: number | null }
/** A freeze, applied at once; or a change for two people, filed as a request (applied at once only for an invited seat that never enrolled). */
export async function change(db: D1Database, actor: Actor, kind: Kind | Direct, subjectId: string, value: string | null, now: number, snapshot: string | null = null) {
  const id = randomId()
  const payload = JSON.stringify({ value })
  const payloadHash = await sha256Hex(payload)
  let outcome: Changed = { error: 'not_found' }
  await commit(db, actor.orgId, async () => {
    const role = await roleNow(db, actor)
    const judged = role ? await judge(db, actor.orgId, role, kind, subjectId, value, now, actor.seatId, snapshot) : 'forbidden'
    if (typeof judged === 'string') {
      outcome = { error: judged }
      return null
    }
    if (judged.direct) {
      outcome = { state: 'applied' }
      return [seatEntry(actor, now, kind, subjectId, judged.detail), judged.apply]
    }
    // An order's subject is the hash of its review: a review is sent once, whatever became of that order.
    if (await db.prepare(`SELECT 1 FROM approvals WHERE org_id = ? AND action = ? AND subject_id = ? AND (action = 'order' OR (state = 'pending' AND expires_at > ?))`).bind(actor.orgId, kind, subjectId, now).first()) {
      outcome = { error: kind === 'order' ? 'review_used' : 'already_requested' }
      return null
    }
    const notBefore = judged.relax ? now + RELAX_MS : null
    outcome = { state: 'requested', id, notBefore }
    return [seatEntry(actor, now, 'approval.request', id, kind), [
      db.prepare(`INSERT INTO approvals (id, org_id, action, subject_id, payload, payload_hash, requester_seat_id, state, not_before, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .bind(id, actor.orgId, kind, subjectId, payload, payloadHash, actor.seatId, notBefore, now + (kind === 'order' ? APPROVE_MS : REQUEST_MS), now),
    ]]
  })
  return outcome as Changed
}

// A request is open while it is pending and younger than 7 days. (Its requester is still an active Owner or Admin:
// a freeze, a removal and a role change cancel what the seat had asked for, in closeOpen.) The confirmation of
// a new passkey (ticket.confirm) lives in the same table and is never decided here.
const OPEN_REQUEST = `a.state = 'pending' AND a.expires_at > ? AND a.action <> 'ticket.confirm'`
/** Approve (and apply, in the same commit), reject, or cancel. Everything that decides it is read here, inside the commit. */
export async function decide(db: D1Database, actor: Actor, id: string, decision: 'approve' | 'reject' | 'cancel', now: number, snapshot: string | null = null) {
  let outcome = 'not_found'
  await commit(db, actor.orgId, async () => {
    const a = await db
      .prepare(`SELECT a.action, a.subject_id, a.payload, a.requester_seat_id, a.not_before, r.role, r.quarantine_until AS quarantine FROM approvals a
                JOIN seats r ON r.org_id = a.org_id AND r.id = a.requester_seat_id
                WHERE a.org_id = ? AND a.id = ? AND ${OPEN_REQUEST}`)
      .bind(actor.orgId, id, now).first<{ action: Kind; subject_id: string; payload: string; requester_seat_id: string; not_before: number | null; role: Role; quarantine: number | null }>()
    const mine = a?.requester_seat_id === actor.seatId
    // The requester cancels and nobody else does. The requester never approves or rejects: approvals also has
    // CHECK (checker <> requester), so the database refuses the row even if this line were gone.
    const role = await roleNow(db, actor)
    outcome = !a || (decision === 'cancel' && !mine) ? 'not_found'
      : decision !== 'cancel' && mine ? 'own_request'
      : decision !== 'cancel' && !(role && KEY_ROLES.includes(role)) ? 'forbidden' // the checker is a key role, now
      : decision === 'approve' && (a.quarantine ?? 0) > now ? 'requester_quarantine' // a re-enrolled seat is contested: what it asked for waits, and its member can cancel
      : decision === 'approve' && (a.not_before ?? 0) > now ? 'too_early'
      : 'ok'
    if (!a || outcome !== 'ok') return null
    const close = (state: string) => db.prepare(`UPDATE approvals SET state = ?, checker_seat_id = ?, decided_at = ? WHERE org_id = ? AND id = ? AND state = 'pending'`)
      .bind(state, decision === 'cancel' ? null : actor.seatId, now, actor.orgId, id)
    if (decision === 'reject') return [seatEntry(actor, now, 'approval.reject', id, a.action), [close('rejected')]]
    if (decision === 'cancel') return [seatEntry(actor, now, 'approval.cancel', id, a.action), [close('cancelled')]]
    const judged = await judge(db, actor.orgId, a.role, a.action, a.subject_id, (JSON.parse(a.payload) as { value: string | null }).value, now, a.requester_seat_id, snapshot)
    if (typeof judged === 'string') {
      outcome = judged
      return null
    }
    return [seatEntry(actor, now, a.action, a.subject_id, judged.detail), [close('applied'), ...judged.apply]]
  })
  return outcome
}

/** The requests that wait: all of them for a key role (who may decide), their own for anyone else. With names, since most roles see no member list. */
export async function openRequests(db: D1Database, actor: Actor, now: number) {
  const { results } = await db
    .prepare(`SELECT a.id, a.action AS kind, a.subject_id AS subjectId, t.display_name AS name, t.role, a.payload, a.requester_seat_id AS requesterSeatId, r.display_name AS requester, r.role AS requesterRole,
                     a.created_at AS createdAt, a.expires_at AS expiresAt, a.not_before AS notBefore
              FROM approvals a JOIN seats r ON r.org_id = a.org_id AND r.id = a.requester_seat_id
              LEFT JOIN seats t ON t.org_id = a.org_id AND t.id = a.subject_id
              WHERE a.org_id = ? AND ${OPEN_REQUEST} AND (? = 1 OR a.requester_seat_id = ?) ORDER BY a.created_at, a.id`)
    .bind(actor.orgId, now, KEY_ROLES.includes(actor.role) ? 1 : 0, actor.seatId).all<{ id: string; kind: Kind; subjectId: string; name: string | null; role: Role | null; payload: string; requesterSeatId: string; requester: string; requesterRole: Role; createdAt: number; expiresAt: number; notBefore: number | null }>()
  return results.map(({ payload, ...a }) => ({ ...a, value: (JSON.parse(payload) as { value: string | null }).value, mine: a.requesterSeatId === actor.seatId }))
}

/**
 * The orders of an organisation, newest first: the approval row (who prepared it, its terms, who decided) and, once
 * approved, its order row (the expiry, the order id, the orderbook's state as last read). ponytail: the 100 newest; page it when a desk has more.
 */
export async function orders(db: D1Database, actor: Actor, now: number) {
  const { results } = await db
    .prepare(`SELECT a.id, a.payload, a.state, a.created_at AS at, a.decided_at AS decidedAt, a.expires_at AS expiresAt, a.requester_seat_id AS seat,
                     r.display_name AS preparer, r.role AS preparerRole, k.display_name AS decidedBy,
                     o.approved_at AS approvedAt, o.valid_to AS validTo, o.uid, o.status, o.sent_at AS sentAt, o.executed_sell AS sold, o.executed_buy AS bought, o.executed_fee AS fee, o.tx_hash AS tx,
                     l.display_name AS linkBy, o.link_at AS linkAt
              FROM approvals a JOIN seats r ON r.org_id = a.org_id AND r.id = a.requester_seat_id
              LEFT JOIN seats k ON k.org_id = a.org_id AND k.id = a.checker_seat_id
              LEFT JOIN orders o ON o.org_id = a.org_id AND o.id = a.id
              LEFT JOIN seats l ON l.org_id = a.org_id AND l.id = o.link_by
              WHERE a.org_id = ? AND a.action = 'order' ORDER BY a.created_at DESC, a.rowid DESC LIMIT 100`)
    .bind(actor.orgId).all<{ id: string; payload: string; state: string; at: number; decidedAt: number | null; expiresAt: number; seat: string; preparer: string; preparerRole: Role; decidedBy: string | null
      approvedAt: number | null; validTo: number | null; uid: string | null; status: string | null; sentAt: number | null; sold: string | null; bought: string | null; fee: string | null; tx: string | null; linkBy: string | null; linkAt: number | null }>()
  return results.map(({ payload, seat, ...o }) => ({ ...o, mine: seat === actor.seatId, open: o.state === 'pending' && o.expiresAt > now, terms: JSON.parse((JSON.parse(payload) as { value: string }).value) as Terms }))
}

/**
 * The filled orders of an organisation sent since `since`, for the monthly statement: the chain and the asset sold of
 * their terms, what was sold, the fee. ponytail: every row of the 12 months, read whole; a month table when that grows.
 */
export async function filledOrders(db: D1Database, orgId: string, since: number) {
  const { results } = await db.prepare(`SELECT json_extract(json_extract(a.payload, '$.value'), '$.chainId') AS chainId, json_extract(json_extract(a.payload, '$.value'), '$.sell.symbol') AS symbol,
                                               o.sent_at AS sentAt, o.executed_sell AS sold, o.executed_fee AS fee
                                        FROM orders o JOIN approvals a ON a.org_id = o.org_id AND a.id = o.id WHERE o.org_id = ? AND o.status = 'fulfilled' AND o.sent_at >= ?`)
    .bind(orgId, since).all<{ chainId: number; symbol: string; sentAt: number; sold: string; fee: string | null }>()
  return results
}

// ---- the real desk after the approval: the signing link, the signing page, the send, the cancel, the state ----
const ORDER_ROW = `SELECT o.org_id AS orgId, o.id, o.approved_at AS approvedAt, o.link_purpose AS purpose, o.valid_to AS validTo, o.uid, o.status, o.sent_at AS sentAt, a.payload,
                          w.id AS walletId, w.chain_id AS walletChain, w.address AS walletAddress
                   FROM orders o JOIN approvals a ON a.org_id = o.org_id AND a.id = o.id
                   JOIN organisations g ON g.id = o.org_id AND g.state = 'active'
                   LEFT JOIN wallets w ON w.org_id = o.org_id AND w.state = 'linked' AND w.id = json_extract(json_extract(a.payload, '$.value'), '$.walletId')`
type OrderRow = { orgId: string; id: string; approvedAt: number; purpose: 'sign' | 'cancel' | null; validTo: number | null; uid: string | null; status: string | null; sentAt: number | null; payload: string; walletId: string | null; walletChain: number | null; walletAddress: string | null }
/**
 * Can this link be used now (?2: now; ?4: the purpose asked for, or null for the link's own)? A signing link: the order is
 * not sent (a sent, refused or withdrawn one has a status), its approval is younger than 1 hour (market) or 24 hours (limit), and the
 * expiry the page fixed, if it did, still leaves the orderbook's minute (orders.signBy says the same). A cancel link: the order is open. An order row exists from its approval on.
 */
const LINK_LIVE = `((COALESCE(?4, o.link_purpose) = 'sign' AND o.status IS NULL AND (o.valid_to IS NULL OR o.valid_to * 1000 - ${MIN_VALID_MS} > ?2)
                     AND o.approved_at + CASE json_extract(json_extract(a.payload, '$.value'), '$.type') WHEN 'limit' THEN ${SIGN_MS.limit} ELSE ${SIGN_MS.market} END > ?2)
                    OR (COALESCE(?4, o.link_purpose) = 'cancel' AND o.status IN ('open', 'presignaturePending') AND o.valid_to * 1000 > ?2))`
const termsOf = (row: { payload: string }) => JSON.parse((JSON.parse(row.payload) as { value: string }).value) as Terms

/** A one-time link for the signing page, issued by a Trader or a key role after the approval: only its SHA-256 is stored, and a new one replaces the last. The record keeps who gave the last signing link, and when. */
export async function orderLink(db: D1Database, actor: Actor, id: string, purpose: 'sign' | 'cancel', tokenHash: string, now: number) {
  let outcome = 'not_found'
  await commit(db, actor.orgId, async () => {
    const role = await roleNow(db, actor)
    // No new signing link while a send holds the order id (orderSending).
    const r = await db.prepare(`${ORDER_ROW} WHERE o.org_id = ?1 AND o.id = ?3 AND ${LINK_LIVE} AND (?4 = 'cancel' OR o.uid IS NULL)`).bind(actor.orgId, now, id, purpose).first<OrderRow>()
    outcome = !role || !(SIGNERS as readonly Role[]).includes(role) ? 'forbidden' : !r ? 'not_found' : 'ok'
    if (outcome !== 'ok') return null
    return [seatEntry(actor, now, 'order.link', id, purpose), [
      db.prepare(`UPDATE orders SET link_hash = ?1, link_purpose = ?2, link_by = CASE WHEN ?2 = 'sign' THEN ?3 ELSE link_by END, link_at = CASE WHEN ?2 = 'sign' THEN ?4 ELSE link_at END WHERE org_id = ?5 AND id = ?6`)
        .bind(tokenHash, purpose, actor.seatId, now, actor.orgId, id),
    ]]
  })
  return outcome
}
/**
 * One person withdraws an approved order before the wallet signs it, as a freeze, since it only tightens: its link dies and
 * no link is given again. While a send holds the order id it may be live already: its link dies all the same (so nothing
 * sends it again), and the answer says so (`being_sent`): withdrawn if the orderbook does not take it, to cancel if it does.
 */
export async function orderWithdraw(db: D1Database, actor: Actor, id: string, now: number) {
  let outcome = 'not_found'
  await commit(db, actor.orgId, async () => {
    const role = await roleNow(db, actor)
    const r = await db.prepare(`${ORDER_ROW} WHERE o.org_id = ?1 AND o.id = ?3 AND ${LINK_LIVE}`).bind(actor.orgId, now, id, 'sign').first<OrderRow>()
    outcome = !role || !(SIGNERS as readonly Role[]).includes(role) ? 'forbidden' : !r ? 'not_found' : r.uid ? 'being_sent' : 'ok'
    if (!r || outcome === 'forbidden') return null
    return [seatEntry(actor, now, 'order.withdraw', id, r.uid ? 'held' : null), [
      db.prepare(`UPDATE orders SET status = CASE WHEN uid IS NULL THEN 'cancelled' END, link_hash = NULL, link_purpose = NULL WHERE org_id = ? AND id = ? AND status IS NULL`).bind(actor.orgId, id),
    ]]
  })
  return outcome
}
/** The order a link opens, while the link can be used, with the wallet of its terms if that wallet is still linked. */
// A Safe's order the orderbook took, its presignature still to come: its sign link answers until the order expires, so a
// page that lost the answer or was reloaded gets the order again and proposes the Safe transaction (Codex, PR #1646).
const PRESIGN_WAITING = `(o.link_purpose = 'sign' AND o.status = 'presignaturePending' AND o.valid_to * 1000 > ?2)`
export const orderByLink = async (db: D1Database, tokenHash: string, now: number) => {
  const r = await db.prepare(`${ORDER_ROW} WHERE o.link_hash = ?1 AND (${LINK_LIVE} OR ${PRESIGN_WAITING})`).bind(tokenHash, now, null, null).first<OrderRow>()
  return r && { ...r, terms: termsOf(r) }
}
type Opening = NonNullable<Awaited<ReturnType<typeof orderByLink>>>
/** Inside a commit: the link is still this order's. */
const linked = async (db: D1Database, r: Opening, tokenHash: string) => Boolean(await db.prepare('SELECT 1 FROM orders WHERE org_id = ? AND id = ? AND link_hash = ?').bind(r.orgId, r.id, tokenHash).first())
// The wallet is the actor only where its signature was checked first (orderSend): a key wallet's send, its cancel, and its
// refusal for a listed address. The page's read, and a Safe's send, cancel and refusal, need the link alone: the system's rows.
// checked: the wallet's signature was verified in this request (false for a refusal at the page, before any signature).
const walletEntry = (r: Opening, now: number, action: string, detail: string | null = null, checked = true): Entry => {
  const signed = checked && r.terms.scheme === 'eip712' && action !== 'order.open'
  return { at: now, actorKind: signed ? 'anchor' : 'system', actorId: signed ? r.terms.walletId : null, sessionId: null, action, subjectId: r.id, detail }
}
/**
 * The signing page read the order: its expiry is fixed now, once, and returned; null when it was fixed already. The order
 * id is the signed terms and the expiry, so two orders with the same terms opened in the same second would be one order on
 * the chain (#1648): the expiry is the first second from `validTo`, in the next minute, that no order of the organisation
 * has. Only this writes valid_to, always through commit(), whose batch fails when another write of the organisation
 * landed after its read: a page that lost the race reads again and takes the next second. Per organisation, as uid is
 * not unique (0017): one wallet may be linked to two organisations.
 */
export async function orderOpened(db: D1Database, r: Opening, tokenHash: string, validTo: number, now: number) {
  let fixed = validTo
  const done = await commit(db, r.orgId, async () => {
    const still = await db.prepare(`SELECT 1 FROM orders o WHERE o.org_id = ? AND o.id = ? AND o.link_hash = ? AND o.valid_to IS NULL`).bind(r.orgId, r.id, tokenHash).first()
    if (!still) return null
    // The taken seconds of that minute, by the index orders_by_expiry (0025): no row read when none is taken.
    const taken = new Set((await db.prepare('SELECT valid_to FROM orders WHERE org_id = ? AND valid_to BETWEEN ? AND ?').bind(r.orgId, validTo, validTo + 59).raw<[number]>()).map(([v]) => v))
    for (fixed = validTo; taken.has(fixed); fixed++) if (fixed === validTo + 59) return null
    return [walletEntry(r, now, 'order.open'), [db.prepare('UPDATE orders SET valid_to = ? WHERE org_id = ? AND id = ? AND valid_to IS NULL').bind(fixed, r.orgId, r.id)]]
  })
  return done ? fixed : null
}
const HOLD_MS = 60_000 // longer than a send can wait for the orderbook (orders.ORDERBOOK, 5 seconds)
/**
 * Before the post, one commit: this link, the order not sent, the approval, the organisation and the wallet as the send
 * read them. From here the send holds the order id (uid, no state) until the orderbook answers: a withdrawal or a new
 * signing link is refused, a freeze lets the send finish, so no stop lands between the post and the record. A hold a
 * minute old belongs to a send that stopped: the same link takes it again (the orderbook answers DuplicatedOrder if it
 * has the order), and the refresh reads it (openOrders). One order per approval.
 */
export async function orderSending(db: D1Database, r: Opening, tokenHash: string, uid: string, signature: string, now: number) {
  let outcome = 'link_invalid'
  await commit(db, r.orgId, async () => {
    const still = await db.prepare(`${ORDER_ROW} WHERE o.org_id = ?1 AND o.id = ?3 AND o.link_hash = ?5 AND ${LINK_LIVE}`).bind(r.orgId, now, r.id, null, tokenHash).first<OrderRow>()
    outcome = !still ? 'link_invalid' : still.walletId !== r.walletId ? 'wallet_not_linked' : still.uid && (still.uid !== uid || still.sentAt! > now - HOLD_MS) ? 'already_sent' : 'ok'
    if (outcome !== 'ok') return null
    return [walletEntry(r, now, 'order.send', r.terms.scheme), [
      db.prepare('UPDATE orders SET uid = ?, signature = ?, sent_at = ?, checked_at = ? WHERE org_id = ? AND id = ? AND status IS NULL').bind(uid, signature, now, now, r.orgId, r.id),
    ]]
  })
  return outcome
}
/** The orderbook took it: the order is live, recorded on the id its send holds, and its link is used (a Safe's waits for its presignature: PRESIGN_WAITING). ponytail: no audit row, the send's is it. */
export const orderSent = (db: D1Database, r: Opening, uid: string, status: string) =>
  db.prepare(`UPDATE orders SET status = ?1, ${KEEP_PRESIGN_LINK} WHERE org_id = ?2 AND id = ?3 AND uid = ?4 AND status IS NULL`).bind(status, r.orgId, r.id, uid).run()
const KEEP_PRESIGN_LINK = `link_hash = CASE WHEN ?1 = 'presignaturePending' THEN link_hash END, link_purpose = CASE WHEN ?1 = 'presignaturePending' THEN link_purpose END`
// The hold ends, if it was taken no later than `before` (a send ends its own hold, never a later one): the order waits
// for its signature on its link, withdrawn if its link died meanwhile (a withdrawal, a freeze). Every way out of a hold
// is one commit (orderUnsent, holdGone, holdFound; orderSent only after the orderbook took it), so none writes over another.
const release = (db: D1Database, x: { orgId: string; id: string; uid: string }, before: number, e: Entry) =>
  commit(db, x.orgId, async () => (await db.prepare('SELECT 1 FROM orders WHERE org_id = ? AND id = ? AND uid = ? AND status IS NULL AND sent_at <= ?').bind(x.orgId, x.id, x.uid, before).first())
    ? [e, [db.prepare(`UPDATE orders SET uid = NULL, signature = NULL, sent_at = NULL, checked_at = NULL, status = CASE WHEN link_hash IS NULL THEN 'cancelled' END
                       WHERE org_id = ? AND id = ? AND uid = ? AND status IS NULL AND sent_at <= ?`).bind(x.orgId, x.id, x.uid, before)]]
    : null)
/** The orderbook refused it (a 4xx) and does not have it: the hold ends. Anything less sure keeps the hold, as the order may be live. */
export const orderUnsent = (db: D1Database, r: Opening, uid: string, why: string, now: number) => release(db, { orgId: r.orgId, id: r.id, uid }, now, walletEntry(r, now, 'order.unsent', why))
/** A hold a minute old that the orderbook does not have (404): its send stopped before the post, or the post never landed. */
export const holdGone = (db: D1Database, x: { orgId: string; id: string; uid: string }, now: number) =>
  release(db, x, now - HOLD_MS, { at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'order.unsent', subjectId: x.id, detail: 'missing' })
/** A hold the orderbook has: the send reached it and its record was lost. Recorded as the orderbook read it, its link used. */
export const holdFound = (db: D1Database, x: { orgId: string; id: string; uid: string }, s: { status: string; sold: string; bought: string; tx: string | null; fee: string | null }, now: number) =>
  commit(db, x.orgId, async () => (await db.prepare('SELECT 1 FROM orders WHERE org_id = ? AND id = ? AND uid = ? AND status IS NULL').bind(x.orgId, x.id, x.uid).first())
    ? [{ at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'order.found', subjectId: x.id, detail: s.status }, [
      db.prepare(`UPDATE orders SET status = ?1, executed_sell = ?2, executed_buy = ?3, executed_fee = ?4, tx_hash = ?5, checked_at = ?6, ${KEEP_PRESIGN_LINK} WHERE org_id = ?7 AND id = ?8 AND uid = ?9 AND status IS NULL`)
        .bind(s.status, s.sold, s.bought, s.fee, s.tx, now, x.orgId, x.id, x.uid),
    ]] : null)
/** What the organisation's other open orders of this wallet still need of the asset this order sells, on its chain, in atoms: the allowance they rely on. */
// Never this order: a Safe's page read again while it waits for its presignature would count it twice (Codex, PR #1646).
// ponytail: reads every order of the organisation (no index on the status). An index on (org_id, status) once a desk keeps thousands.
export async function reserved(db: D1Database, r: Opening, now: number) {
  const { results } = await db.prepare(`SELECT json_extract(v, '$.sell.amount') AS amount FROM (SELECT json_extract(a.payload, '$.value') AS v FROM orders o JOIN approvals a ON a.org_id = o.org_id AND a.id = o.id
                                          WHERE o.org_id = ? AND o.id <> ? AND o.status IN ('open', 'presignaturePending') AND o.valid_to * 1000 > ?)
                                        WHERE json_extract(v, '$.chainId') = ? AND json_extract(v, '$.wallet') = ? AND json_extract(v, '$.sell.token') = ?`)
    .bind(r.orgId, r.id, now, r.terms.chainId, r.terms.wallet, r.terms.sell.token).all<{ amount: string }>()
  return results.reduce((sum, x) => sum + BigInt(x.amount), 0n)
}
/** The first address of these on a loaded sanctions list, or null. */
export const listedOf = async (db: D1Database, addresses: string[]) =>
  (await db.prepare(`SELECT address FROM sanctioned_addresses WHERE address IN (${addresses.map(() => '?').join(', ')}) LIMIT 1`).bind(...addresses.map((a) => a.toLowerCase())).first<{ address: string }>())?.address ?? null
/** An order refused before it was sent, because an address of it is on a loaded list: flagged in the log, and it is never sent. */
export const orderListed = (db: D1Database, r: Opening, tokenHash: string, which: string, now: number, checked = true) =>
  commit(db, r.orgId, async () => (await linked(db, r, tokenHash)) ? [walletEntry(r, now, 'order.sanctioned', which, checked), [
    db.prepare(`UPDATE orders SET status = 'refused', link_hash = NULL, link_purpose = NULL WHERE org_id = ? AND id = ? AND uid IS NULL`).bind(r.orgId, r.id),
  ]] : null)
/** A cancel: the orderbook took a key wallet's cancellation (`cancelled`), or the Safe was asked to revoke its presignature. */
export const orderCancelled = (db: D1Database, r: Opening, tokenHash: string, how: 'key' | 'safe', now: number) =>
  commit(db, r.orgId, async () => (await linked(db, r, tokenHash)) ? [walletEntry(r, now, 'order.cancel', how), [
    db.prepare(`UPDATE orders SET link_hash = NULL, link_purpose = NULL, status = CASE WHEN ? = 'key' THEN 'cancelled' ELSE status END WHERE org_id = ? AND id = ?`).bind(how, r.orgId, r.id),
  ]] : null)
/** Sent orders whose state may still change, least recently read first: of one organisation, or of all (the daily run). */
// With the holds of sends that stopped (an order id, no state): read until the orderbook says what became of them, expired or not.
// And a filled order whose transaction was not read yet (the trades answer failed once), for 7 days after its expiry: its
// fill is recorded, its transaction link follows (Codex, PR #1646).
export async function openOrders(db: D1Database, orgId: string | null, limit: number, now: number) {
  const { results } = await db.prepare(`SELECT o.org_id AS orgId, o.id, o.uid, o.status, a.payload FROM orders o JOIN approvals a ON a.org_id = o.org_id AND a.id = o.id
                                        WHERE (o.status IN ('open', 'presignaturePending') OR (o.status IS NULL AND o.uid IS NOT NULL) OR (o.status = 'fulfilled' AND o.tx_hash IS NULL AND o.valid_to * 1000 > ?3))
                                          AND (?1 IS NULL OR o.org_id = ?1)
                                        ORDER BY o.checked_at, o.rowid LIMIT ?2`)
    .bind(orgId, limit, now - 7 * 24 * 60 * 60 * 1000).all<{ orgId: string; id: string; uid: string; status: string | null; payload: string }>()
  return results.map((r) => ({ orgId: r.orgId, id: r.id, uid: r.uid, held: r.status === null, chainId: termsOf(r).chainId, sellToken: termsOf(r).sell.token }))
}
/**
 * The orderbook's state, written as read. ponytail: a copy of the public orderbook, so no audit row of its own and no
 * commit (the people's decisions are in the log: the approval, the link, the send, the cancel). One batch.
 */
// `tried`: read with nothing to write (the orderbook did not answer, or does not have it): their turn moves on all the
// same, so orders an orderbook cannot answer for never hold the refresh's window (Codex, PR #1646).
export async function orderStates(db: D1Database, read: { orgId: string; id: string; status: string; sold: string; bought: string; tx: string | null; fee: string | null }[], now: number, tried: { orgId: string; id: string }[] = []) {
  if (read.length || tried.length) await db.batch([
    ...read.map((x) => db.prepare(`UPDATE orders SET status = ?, executed_sell = ?, executed_buy = ?, executed_fee = ?, tx_hash = COALESCE(?, tx_hash), checked_at = ? WHERE org_id = ? AND id = ? AND (status IN ('open', 'presignaturePending') OR (status = 'fulfilled' AND tx_hash IS NULL))`)
      .bind(x.status, x.sold, x.bought, x.fee, x.tx, now, x.orgId, x.id)),
    ...tried.map((x) => db.prepare('UPDATE orders SET checked_at = ? WHERE org_id = ? AND id = ?').bind(now, x.orgId, x.id)),
  ])
}

// ---- milestone 4a: wallets and the recovery wallet ----

// A pending wallet is live only while its request is open. A reject, a cancel or the 7 days leave a row that no
// list shows and that the next link sweeps to 'unlinked'; the row stays, so its proof is never accepted again.
const OPEN_LINK = `EXISTS (SELECT 1 FROM approvals a WHERE a.org_id = w.org_id AND a.subject_id = w.id AND a.action = 'wallet.link' AND a.state = 'pending' AND a.expires_at > ?)`
const LIVE = `(w.state = 'linked' OR (w.state = 'pending' AND ${OPEN_LINK}))`

// ---- sanctions screening: the address lists the operator loads (onboarding.ts) ----
// A listed address is never linked: every write that makes a wallet row, or makes one linked, reads the lists inside
// its commit (linkWallet and the approval of a link here; the activation proof and the operator's approval in
// onboarding.ts) and refuses with "wallet_listed". The stop of a recovery, which is never refused, leaves such a wallet
// unlinked. Two triggers of 0012 refuse the same at the write itself: a load is no commit of the organisation.
/**
 * SQL: the wallet row `w` is live, at an address on a loaded list (bind now). Live: linked; pending with an open
 * request; or pending in an organisation that is not yet verified, whose named wallet has no request. A row whose
 * request was rejected, cancelled or has expired stays 'pending' for good and counts for nothing.
 */
export const LISTED = `(${LIVE} OR (w.state = 'pending' AND (SELECT x.state FROM organisations x WHERE x.id = w.org_id) = 'unverified')) AND w.address IN (SELECT address FROM sanctioned_addresses)`
/** Is this address on a loaded list? */
export const listed = async (db: D1Database, address: string) => Boolean(await db.prepare('SELECT 1 FROM sanctioned_addresses WHERE address = ? LIMIT 1').bind(address).first())
/** For the partner figures (partner.ts), in one batch: each loaded list (its name, the day it was published, the day it
 *  was loaded), and each listed address with the names of its lists. */
export async function sanctionsHeld(db: D1Database) {
  const [lists, rows] = await db.batch([
    db.prepare('SELECT list, published, loaded_at AS loadedAt FROM sanctions_lists ORDER BY list'),
    db.prepare('SELECT address, group_concat(list) AS lists FROM sanctioned_addresses GROUP BY address ORDER BY address'),
  ])
  return {
    lists: (lists.results as { list: string; published: string | null; loadedAt: number }[]).map((l) => ({ name: LISTS[l.list], published: l.published, loaded: new Date(l.loadedAt).toISOString().slice(0, 10) })),
    of: new Map((rows.results as { address: string; lists: string }[]).map((r) => [r.address, r.lists.split(',').sort().map((code) => LISTS[code])])),
  }
}
/** The first live wallet of an organisation that is on a loaded list, or null. */
export const listedWallet = (db: D1Database, orgId: string, now: number) => db.prepare(`SELECT w.id FROM wallets w WHERE w.org_id = ? AND ${LISTED} ORDER BY w.rowid LIMIT 1`).bind(orgId, now).first<{ id: string }>()
/** The statements of a freeze by the operator or by the screening: the organisation, if it is active, and every session of it (G4). */
export const freezing = (db: D1Database, orgId: string, now: number): Sql[] => [
  db.prepare(`UPDATE organisations SET state = 'frozen' WHERE id = ? AND state = 'active'`).bind(orgId),
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND revoked_at IS NULL').bind(now, orgId),
]
// "In force" is computed at read: a waiting recovery wallet whose 72 hours have passed is the one in force, and the
// one it replaced no longer is. promote() writes that down in the next wallet write. No scheduled job.
function standing(rows: { id: string; anchor: string | null; at: number | null }[], now: number) {
  const next = rows.find((w) => w.anchor === 'next')
  const matured = next !== undefined && (next.at ?? 0) <= now
  return { inForce: (matured ? next : rows.find((w) => w.anchor === 'current'))?.id ?? null, waiting: matured ? null : next?.id ?? null }
}
const anchors = async (db: D1Database, orgId: string, now: number) =>
  standing((await db.prepare('SELECT id, anchor, anchor_effective_at AS at FROM wallets WHERE org_id = ? AND anchor IS NOT NULL').bind(orgId).all<{ id: string; anchor: string; at: number | null }>()).results, now)
const promote = (db: D1Database, orgId: string, now: number): Sql[] => [
  db.prepare(`UPDATE wallets SET anchor = NULL, anchor_effective_at = NULL WHERE org_id = ? AND anchor = 'current'
              AND EXISTS (SELECT 1 FROM wallets n WHERE n.org_id = wallets.org_id AND n.anchor = 'next' AND n.anchor_effective_at <= ?)`).bind(orgId, now),
  db.prepare(`UPDATE wallets SET anchor = 'current' WHERE org_id = ? AND anchor = 'next' AND anchor_effective_at <= ?`).bind(orgId, now),
]

export type WalletKind = 'safe' | 'custodian' | 'single_key'
/** The live wallets of an organisation. recovery: 'in_force' (since recoveryAt), 'waiting' (in force from recoveryAt), or null. */
export async function wallets(db: D1Database, orgId: string, now: number) {
  const { results } = await db
    .prepare(`SELECT w.id, w.chain_id AS chainId, w.address, w.kind, w.label, w.state, w.linked_at AS linkedAt, w.anchor, w.anchor_effective_at AS at, w.snapshot, w.proof_by AS proofBy
              FROM wallets w WHERE w.org_id = ? AND ${LIVE} ORDER BY w.rowid`)
    .bind(orgId, now).all<{ id: string; chainId: number; address: string; kind: WalletKind; label: string; state: 'pending' | 'linked'; linkedAt: number; anchor: string | null; at: number | null; snapshot: string | null; proofBy: 'key' | 'contract' | null }>()
  const a = standing(results, now)
  return results.map(({ anchor: _, at, ...w }) => {
    const recovery = w.id === a.inForce ? ('in_force' as const) : w.id === a.waiting ? ('waiting' as const) : null
    return { ...w, recovery, recoveryAt: recovery ? at : null }
  })
}
/** The linked wallets of an organisation with the proof of each link, oldest first: what the partner figures ask for (partner.ts). */
export const linkedProofs = async (db: D1Database, orgId: string) =>
  (await db.prepare(`SELECT chain_id AS chainId, address, label, proof_digest AS digest, proof_signature AS signature, proof_by AS proofBy FROM wallets WHERE org_id = ? AND state = 'linked' ORDER BY rowid`)
    .bind(orgId).all<{ chainId: number; address: string; label: string; digest: string; signature: string; proofBy: 'key' | 'contract' | null }>()).results
/** Is this address linked, or waiting for its second person, in this organisation? */
export const walletLive = async (db: D1Database, orgId: string, chainId: number, address: string, now: number) =>
  Boolean(await db.prepare(`SELECT 1 FROM wallets w WHERE w.org_id = ? AND w.chain_id = ? AND w.address = ? AND ${LIVE}`).bind(orgId, chainId, address, now).first())
/** The linked wallet a recovery-wallet change is about, by its own id or by the id of the open request for it: what the caller reads on the chain before the write. */
export const walletFor = (db: D1Database, actor: Actor, id: string, now: number) =>
  db.prepare(`SELECT w.chain_id AS chainId, w.address, w.kind FROM wallets w WHERE w.org_id = ? AND w.state = 'linked'
              AND (w.id = ? OR w.id = (SELECT a.subject_id FROM approvals a WHERE a.org_id = w.org_id AND a.id = ? AND a.action = 'anchor.set' AND ${OPEN_REQUEST}))`)
    .bind(actor.orgId, id, id, now).first<{ chainId: number; address: string; kind: WalletKind }>()

type Linked = { error: 'forbidden' | 'quarantine' | 'already_linked' | 'proof_used' | 'wallet_listed' } | { state: 'linked' | 'pending' }
// A valid proof arrived for an intent of this seat: the first write of the whole link. Everything that decides it is
// read here, inside the commit: the seat is still an active Owner or Admin and not in quarantine, the proof was never
// accepted before, the address is not live. Where the 30 day rule lets one person stand for two the wallet is linked
// at once; otherwise it is pending, with a request of that seat that a different key-role member approves.
export async function linkWallet(
  db: D1Database,
  w: { orgId: string; seatId: string; chainId: number; address: string; kind: WalletKind; label: string; snapshot: string | null; nonce: string; digest: string; signature: string; by: 'key' | 'contract'; now: number },
) {
  const id = randomId()
  const requestId = randomId()
  const payload = JSON.stringify({ value: null })
  const payloadHash = await sha256Hex(payload)
  const { now } = w
  let outcome: Linked = { error: 'forbidden' }
  // The wallet row of this proof: it holds the nonce, so a proof is used once whatever became of it.
  const row = (state: 'linked' | 'pending' | 'unlinked') =>
    db.prepare(`INSERT INTO wallets (id, org_id, chain_id, address, kind, label, state, proof_nonce, proof_digest, proof_signature, proof_by, proof_checked_at, linked_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, w.orgId, w.chainId, w.address, w.kind, w.label, state, w.nonce, w.digest, w.signature, w.by, now, now, w.snapshot)
  await commit(db, w.orgId, async () => {
    const seat = await db.prepare(`SELECT s.role, max(COALESCE(s.quarantine_until, 0), COALESCE(o.quarantine_until, 0)) AS quarantine FROM seats s JOIN organisations o ON o.id = s.org_id AND o.state = 'active'
                                   WHERE s.org_id = ? AND s.id = ? AND s.state = 'active'`).bind(w.orgId, w.seatId).first<{ role: Role; quarantine: number | null }>()
    const refused = !seat || (seat.role !== 'owner' && seat.role !== 'admin') ? 'forbidden'
      : (seat.quarantine ?? 0) > now ? 'quarantine'
      : (await db.prepare('SELECT 1 FROM wallets WHERE proof_nonce = ?').bind(w.nonce).first()) ? 'proof_used'
      : (await walletLive(db, w.orgId, w.chainId, w.address, now)) ? 'already_linked'
      : (await listed(db, w.address)) ? 'wallet_listed'
      : null
    if (refused) {
      outcome = { error: refused }
      // A proven attempt to link a listed address leaves its trace: one row in the organisation's log, and the freeze a load
      // of that address would have made, with every session ended, in this commit. The answer is the refusal.
      // The proof is kept as a row that is never live ('unlinked'): its nonce is used, so the same proof, which stays valid
      // for a week and is taken from anyone, answers "proof_used" and cannot freeze the organisation a second time.
      return refused !== 'wallet_listed' ? null
        : [{ at: now, actorKind: 'seat', actorId: w.seatId, sessionId: null, action: 'screening.attempt', subjectId: id, detail: w.address }, [row('unlinked'), ...freezing(db, w.orgId, now)]]
    }
    const direct = await alone(db, w.orgId, w.seatId, now)
    outcome = { state: direct ? 'linked' : 'pending' }
    const entry: Entry = { at: now, actorKind: 'seat', actorId: w.seatId, sessionId: null, action: direct ? 'wallet.link' : 'approval.request', subjectId: direct ? id : requestId, detail: direct ? 'alone' : 'wallet.link' }
    return [entry, [
      db.prepare(`UPDATE wallets AS w SET state = 'unlinked' WHERE w.org_id = ? AND w.state = 'pending' AND NOT ${OPEN_LINK}`).bind(w.orgId, now),
      row(direct ? 'linked' : 'pending'),
      ...(direct ? [] : [db.prepare(`INSERT INTO approvals (id, org_id, action, subject_id, payload, payload_hash, requester_seat_id, state, expires_at, created_at) VALUES (?, ?, 'wallet.link', ?, ?, ?, ?, 'pending', ?, ?)`)
        .bind(requestId, w.orgId, id, payload, payloadHash, w.seatId, now + REQUEST_MS, now)]),
    ]]
  })
  return outcome as Linked
}

/** For the readiness block: the passkeys that count for each active Owner (device-bound, or any where the organisation allows synced ones), and the recovery wallet in force (failing that, the one that waits). */
export async function readiness(db: D1Database, actor: Actor, now: number) {
  const owners = await db.prepare(`SELECT (SELECT count(*) FROM credentials k WHERE k.org_id = s.org_id AND k.seat_id = s.id AND k.state = 'active' AND (k.device_bound = 1 OR (SELECT synced_keys_allowed FROM organisations WHERE id = s.org_id) = 1)) AS keys
                                   FROM seats s WHERE s.org_id = ? AND s.role = 'owner' AND s.state = 'active' AND NOT ${gone('s')}`).bind(actor.orgId, now).all<{ keys: number }>()
  const all = await wallets(db, actor.orgId, now)
  return { owners: owners.results.map((owner) => owner.keys), wallet: all.find((w) => w.recovery === 'in_force') ?? all.find((w) => w.recovery === 'waiting') ?? null }
}

// ---- milestone 4b: last-Owner recovery (recovery.md section 4) ----

/**
 * Counts one event of `key` in this clock hour and says whether it is within `max`. No audit row, no other row read.
 * Proof checks count under the organisation id of a MAC-signed intent (the only write a proof makes before its
 * commit); Support counts a seat's questions under "seat:<id>", a key no organisation id can be.
 * ponytail: a fixed window per clock hour, so up to twice `max` can straddle an hour. One table (proof_checks, the key
 * in its column org_id, no foreign key) for link proofs, recovery proofs and questions: whoever holds valid intents
 * of an organisation can use up its hour of proofs (Turnstile, not built, is the brake).
 */
export async function countHour(db: D1Database, key: string, now: number, max: number) {
  const hour = Math.floor(now / HOUR)
  const [, counted] = await db.batch<{ n: number }>([
    db.prepare('DELETE FROM proof_checks WHERE hour < ?').bind(hour),
    db.prepare('INSERT INTO proof_checks (org_id, hour, n) VALUES (?, ?, 1) ON CONFLICT (org_id, hour) DO UPDATE SET n = n + 1 RETURNING n').bind(key, hour),
  ])
  return counted.results[0].n <= max
}
export const countProof = (db: D1Database, orgId: string, now: number) => countHour(db, orgId, now, MAX_PROOFS)
/** A bot-check token's hash, kept 10 minutes (a token lives 5): true at its first use, false after (used_tokens). */
export async function firstUse(db: D1Database, hash: string, now: number) {
  const [, taken] = await db.batch([
    db.prepare('DELETE FROM used_tokens WHERE until < ?').bind(now),
    db.prepare('INSERT INTO used_tokens (hash, until) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(hash, now + 10 * 60_000),
  ])
  return taken.meta.changes === 1
}

// A request is open from its proof until it is cancelled, completed or lapsed. 'ready' is never written: a waiting
// request whose wait is over is ready, and 7 days later it has lapsed, whatever its row says. No scheduled job.
const OPEN_RECOVERY = `r.state = 'waiting' AND r.wait_until + ${READY_MS} > ?`
export interface RecoveryRow {
  id: string; seat_id: string; wallet_id: string; action: 'replace_owners' | 'override_owners'; nonce: string; digest: string; signature: string; owners_snapshot: string
  wait_until: number; objected: number; chainId: number; address: string; kind: WalletKind; snapshot: string | null
}
/** The open request of an organisation, with the wallet that signed it: by its id, its nonce or its seat, or whichever is open. Of an active organisation only, since every plan reads it again inside its commit; except by its nonce, which is how the wallet's own cancel finds it: that only closes, also in a frozen organisation. */
export const recoveryRow = (db: D1Database, orgId: string, now: number, by: 'id' | 'nonce' | 'seat_id' = 'id', value: string | null = null) =>
  db.prepare(`SELECT r.id, r.seat_id, r.wallet_id, r.action, r.nonce, r.digest, r.signature, r.owners_snapshot, r.wait_until, r.objected, w.chain_id AS chainId, w.address, w.kind, w.snapshot
              FROM recovery_requests r JOIN wallets w ON w.org_id = r.org_id AND w.id = r.wallet_id
              WHERE r.org_id = ? AND ${OPEN_RECOVERY} AND (? IS NULL OR r.${by} = ?) AND (? = 'nonce' OR EXISTS (SELECT 1 FROM organisations o WHERE o.id = r.org_id AND o.state = 'active'))`)
    .bind(orgId, now, value, value, by).first<RecoveryRow>()
// Ends a request that did not complete: its pending passkey is revoked and its seat, which nobody ever held, is removed.
const closeRecovery = (db: D1Database, orgId: string, r: { id: string; seat_id: string }, state: 'cancelled' | 'lapsed', now: number): Sql[] => [
  db.prepare(`UPDATE recovery_requests SET state = ?, closed_at = ? WHERE org_id = ? AND id = ? AND state = 'waiting'`).bind(state, now, orgId, r.id),
  db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND seat_id = ? AND state <> 'revoked'`).bind(orgId, r.seat_id),
  db.prepare(`UPDATE seats SET state = 'removed' WHERE org_id = ? AND id = ?`).bind(orgId, r.seat_id),
]

/** The people of an organisation: its seats that hold a passkey which signs in or can still stop something. A recovery wallet with a single key stands only for one (here, and at "Submit for review": G5). */
export const PEOPLE = (org: string, now: string) => `(SELECT count(*) FROM seats s WHERE s.org_id = ${org} AND s.state IN ('active', 'frozen') AND EXISTS (SELECT 1 FROM credentials k WHERE k.org_id = s.org_id AND k.seat_id = s.id
  AND (k.state = 'active' OR (k.state = 'suspended' AND (k.stop_right_until IS NULL OR k.stop_right_until > ${now})))))`
export interface RecoveryAsk { orgId: string; override: boolean; seatId: string; credential: { id: string; publicKey: string; counter: number; transports: string[]; deviceBound?: boolean }; credentialHash: string; nonce: string }
export interface Anchor { id: string; chainId: number; address: string; kind: WalletKind; snapshot: string | null }
/**
 * The rows that decide whether a request can open, as they are now: the organisation is active, it has a recovery
 * wallet in force, no other request is open, this proof (nonce, passkey) was never accepted, the last cancel is 24
 * hours old, no completed recovery can still be stopped, and a single key stands only for an organisation of one person (one seat that holds a passkey which
 * signs in or can still stop something). Read by the handler before the signature is checked, so that no endpoint is
 * asked for a request that cannot open, and again inside the commit.
 */
export async function recoverable(db: D1Database, ask: Pick<RecoveryAsk, 'orgId' | 'nonce' | 'credential'>, now: number): Promise<{ error: string } | { wallet: Anchor }> {
  const inForce = (await anchors(db, ask.orgId, now)).inForce
  const found = inForce === null ? null : await db.prepare(`SELECT w.id, w.chain_id AS chainId, w.address, w.kind, w.snapshot, o.synced_keys_allowed AS synced FROM wallets w JOIN organisations o ON o.id = w.org_id AND o.state = 'active'
                                                             WHERE w.org_id = ? AND w.id = ?`).bind(ask.orgId, inForce).first<Anchor & { synced: number }>()
  if (!found) return { error: 'no_recovery_wallet' }
  const { synced, ...wallet } = found
  // The new Owner's passkey: a hardware key where the organisation requires one (owner, 2026-11-17). The intent carries
  // the flag under the server's MAC; an intent sealed before has none, and its passkey was a hardware key then.
  if (needsHardware('owner', synced) && ask.credential.deviceBound === false) return { error: 'device_bound_required' }
  if (await recoveryRow(db, ask.orgId, now)) return { error: 'request_open' }
  const seen = (await db.prepare(`SELECT (SELECT count(*) FROM recovery_requests WHERE nonce = ?) + (SELECT count(*) FROM credentials WHERE id = ?) AS used,
                                         (SELECT max(closed_at) FROM recovery_requests WHERE org_id = ? AND state = 'cancelled') AS cancelled,
                                         (SELECT count(*) FROM credentials k JOIN recovery_requests r ON r.org_id = k.org_id AND r.state = 'completed' AND r.closed_at + ${STOP_MS} = k.stop_right_until
                                          WHERE k.org_id = ? AND k.state = 'suspended' AND k.stop_right_until > ?) AS stoppable,
                                         ${PEOPLE('?', '?')} AS people`)
    .bind(ask.nonce, ask.credential.id, ask.orgId, ask.orgId, now, ask.orgId, now).first<{ used: number; cancelled: number | null; stoppable: number; people: number }>())!
  if (seen.used) return { error: 'proof_used' }
  if ((seen.cancelled ?? -DAY) + DAY > now) return { error: 'wait_after_cancel' }
  // A second request would complete on top of the first: the Owner it makes is not removed by a stop of the first.
  if (seen.stoppable) return { error: 'stop_open' }
  if (wallet.kind === 'single_key' && seen.people > 1) return { error: 'single_key' }
  return { wallet }
}

type Opened = { error: string } | { state: 'waiting'; until: number }
/**
 * A valid proof of the recovery wallet arrived: the first write of the whole request, in one commit. The request
 * waits 72 hours, with the Safe as both endpoints saw it just now (`live`, read by the handler); a new Owner seat is
 * invited and holds the pending passkey; the audit row names the wallet. Every member is told from these rows.
 * An override also needs the wallet green now, and an Owner's cancel or stop in the last 30 days (the audit rows).
 */
export async function openRecovery(db: D1Database, ask: RecoveryAsk, proof: { walletId: string; digest: string; signature: string; live: SafeState | null }, now: number) {
  const id = randomId()
  let outcome: Opened = { error: 'no_recovery_wallet' }
  await commit(db, ask.orgId, async () => {
    const can = await recoverable(db, ask, now)
    const wallet = 'wallet' in can && can.wallet.id === proof.walletId ? can.wallet : null
    const refused = 'error' in can ? can.error
      : !wallet ? 'no_recovery_wallet'
      : wallet.kind === 'safe' && !proof.live ? 'wallet_unreadable'
      : ask.override && colour({ ...wallet, inForce: true }, proof.live).level !== 'green' ? 'override_refused'
      : ask.override && !(await db.prepare(`SELECT 1 FROM audit_log WHERE org_id = ? AND at > ? AND ((action = 'recovery.cancel' AND actor_kind = 'seat') OR action = 'recovery.stop')`).bind(ask.orgId, now - OVERRIDE_MS).first()) ? 'override_refused'
      : null
    if (refused || !wallet) {
      outcome = { error: refused ?? 'no_recovery_wallet' }
      return null
    }
    outcome = { state: 'waiting', until: now + WAIT_MS }
    const lapsed = `SELECT seat_id FROM recovery_requests WHERE org_id = ? AND state = 'waiting' AND wait_until + ${READY_MS} <= ?`
    return [{ at: now, actorKind: 'anchor', actorId: wallet.id, sessionId: null, action: 'recovery.open', subjectId: id, detail: ask.override ? 'override' : null }, [
      // Requests that lapsed by the clock are written down as lapsed first: the index allows one open row per organisation.
      db.prepare(`UPDATE credentials SET state = 'revoked' WHERE org_id = ? AND state <> 'revoked' AND seat_id IN (${lapsed})`).bind(ask.orgId, ask.orgId, now),
      db.prepare(`UPDATE seats SET state = 'removed' WHERE org_id = ? AND id IN (${lapsed})`).bind(ask.orgId, ask.orgId, now),
      db.prepare(`UPDATE recovery_requests SET state = 'lapsed', closed_at = wait_until + ${READY_MS} WHERE org_id = ? AND state = 'waiting' AND wait_until + ${READY_MS} <= ?`).bind(ask.orgId, now),
      db.prepare(`INSERT INTO seats (id, org_id, display_name, role, state, created_at) VALUES (?, ?, 'Recovery Owner', 'owner', 'invited', ?)`).bind(ask.seatId, ask.orgId, now),
      db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Recovery key', 'pending', ?)`)
        .bind(ask.credential.id, ask.orgId, ask.seatId, ask.credential.publicKey, ask.credential.counter, ask.credential.deviceBound === false ? 0 : 1, JSON.stringify(ask.credential.transports), now),
      db.prepare(`INSERT INTO recovery_requests (id, org_id, wallet_id, seat_id, action, credential_hash, nonce, digest, signature, owners_snapshot, state, wait_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`)
        .bind(id, ask.orgId, wallet.id, ask.seatId, ask.override ? 'override_owners' : 'replace_owners', ask.credentialHash, ask.nonce, proof.digest, proof.signature, JSON.stringify(proof.live), now + WAIT_MS, now),
    ]]
  })
  return outcome as Opened
}

/** Cancel, while the request is open: an Owner (never an override), or the recovery wallet, which signed "Cancel account recovery" with the request's nonce. */
export async function cancelRecovery(db: D1Database, orgId: string, by: Actor | { nonce: string }, id: string, now: number) {
  let outcome = 'not_found'
  await commit(db, orgId, async () => {
    const r = 'nonce' in by ? await recoveryRow(db, orgId, now, 'nonce', by.nonce) : await recoveryRow(db, orgId, now, 'id', id)
    outcome = !r ? 'not_found' : 'nonce' in by ? 'ok' : (await roleNow(db, by)) !== 'owner' ? 'forbidden' : r.action === 'override_owners' ? 'override' : 'ok'
    if (!r || outcome !== 'ok') return null
    const entry: Entry = 'nonce' in by ? { at: now, actorKind: 'anchor', actorId: r.wallet_id, sessionId: null, action: 'recovery.cancel', subjectId: r.id, detail: 'wallet' } : seatEntry(by, now, 'recovery.cancel', r.id)
    return [entry, closeRecovery(db, orgId, r, 'cancelled', now)]
  })
  return outcome
}

/** An objection, during the wait: an Admin, Approver or Compliance officer adds 72 hours, once per request. */
export async function objectRecovery(db: D1Database, actor: Actor, id: string, now: number) {
  let outcome = 'not_found'
  await commit(db, actor.orgId, async () => {
    const r = await recoveryRow(db, actor.orgId, now, 'id', id)
    const role = await roleNow(db, actor)
    outcome = !r || r.wait_until <= now ? 'not_found' : !role || role === 'owner' || !KEY_ROLES.includes(role) ? 'forbidden' : r.objected ? 'already_objected' : 'ok'
    if (!r || outcome !== 'ok') return null
    return [seatEntry(actor, now, 'recovery.object', r.id), [db.prepare('UPDATE recovery_requests SET objected = 1, wait_until = wait_until + ? WHERE org_id = ? AND id = ?').bind(WAIT_MS, actor.orgId, r.id)]]
  })
  return outcome
}

/**
 * Completion, by the pending passkey after its check, in one commit. `same`: the handler verified the proof again and
 * read the wallet on both endpoints, and it is as the request's snapshot says.
 * Not the same: the request lapses. The same: the seat is an active Owner and its session opens; every other Owner
 * seat loses its sessions, its open links and requests, and its active passkeys, which are suspended with a stop
 * right of 7 days (an override revokes them and removes those seats: nobody stops it); the organisation is in
 * quarantine for 7 days.
 */
export async function completeRecovery(
  db: D1Database,
  c: { orgId: string; seatId: string; credentialId: string; counter: number; same: boolean; tokenHash: string; challengeHash: string; userAgent: string | null; country: string | null; asn: number | null },
  now: number,
) {
  const sessionId = randomId()
  let outcome: 'denied' | 'lapsed' | 'completed' = 'denied'
  await commit(db, c.orgId, async () => {
    const r = await recoveryRow(db, c.orgId, now, 'seat_id', c.seatId)
    outcome = 'denied' // a second run of the plan starts again
    if (!r || r.wait_until > now) return null // the passkey is the request's: the handler found the request by the passkey's seat, and that seat holds no other
    if (!c.same) {
      outcome = 'lapsed'
      return [{ at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'recovery.lapse', subjectId: r.id }, closeRecovery(db, c.orgId, r, 'lapsed', now)]
    }
    const override = r.action === 'override_owners'
    const owners = `SELECT id FROM seats WHERE org_id = ? AND role = 'owner' AND id <> ?`
    const others = (await db.prepare(`${owners} AND state <> 'removed'`).bind(c.orgId, r.seat_id).all<{ id: string }>()).results
    // What a stop puts back: the recovery wallet in force and the one that waits, as they are at this moment.
    const undo = (await db.prepare('SELECT id, anchor, anchor_effective_at AS at FROM wallets WHERE org_id = ? AND anchor IS NOT NULL').bind(c.orgId).all()).results
    outcome = 'completed'
    return [{ at: now, actorKind: 'seat', actorId: r.seat_id, sessionId, action: 'recovery.complete', subjectId: r.id, detail: override ? 'override' : null, country: c.country, asn: c.asn }, [
      // An override revokes every passkey of those seats, also one that a re-enrolment had suspended: its stop would bring a removed seat back.
      db.prepare(`UPDATE credentials SET state = ?, stop_right_until = ? WHERE org_id = ? AND state ${override ? `<> 'revoked'` : `= 'active'`} AND seat_id IN (${owners})`).bind(override ? 'revoked' : 'suspended', override ? null : now + STOP_MS, c.orgId, c.orgId, r.seat_id),
      db.prepare(`UPDATE sessions SET revoked_at = ? WHERE org_id = ? AND revoked_at IS NULL AND seat_id IN (${owners})`).bind(now, c.orgId, c.orgId, r.seat_id),
      ...others.flatMap((seat) => closeOpen(db, c.orgId, seat.id, now, true)),
      ...(override ? [db.prepare(`UPDATE seats SET state = 'removed' WHERE org_id = ? AND id IN (${owners})`).bind(c.orgId, c.orgId, r.seat_id)] : []),
      db.prepare(`UPDATE credentials SET state = 'active', counter = max(counter, ?), last_used_at = ? WHERE org_id = ? AND id = ?`).bind(c.counter, now, c.orgId, c.credentialId),
      db.prepare(`UPDATE seats SET state = 'active' WHERE org_id = ? AND id = ?`).bind(c.orgId, r.seat_id),
      db.prepare('UPDATE organisations SET quarantine_until = ? WHERE id = ?').bind(now + STOP_MS, c.orgId),
      // The wallet that signed is the recovery wallet from here on. A change the replaced Owners made since, waiting
      // or in force, is undone: their wallet must not stand behind the new Owner (it could replace or override in turn).
      db.prepare('UPDATE wallets SET anchor = NULL, anchor_effective_at = NULL WHERE org_id = ? AND anchor IS NOT NULL AND id <> ?').bind(c.orgId, r.wallet_id),
      db.prepare(`UPDATE wallets SET anchor = 'current', anchor_effective_at = COALESCE(anchor_effective_at, ?) WHERE org_id = ? AND id = ?`).bind(now, c.orgId, r.wallet_id),
      db.prepare(`UPDATE recovery_requests SET state = 'completed', closed_at = ?, undo = ? WHERE org_id = ? AND id = ? AND state = 'waiting'`).bind(now, JSON.stringify(undo), c.orgId, r.id),
      // sessions.challenge_hash is UNIQUE: the same passkey check cannot open a second session.
      db.prepare(`INSERT INTO sessions (id, token_hash, challenge_hash, org_id, seat_id, credential_id, created_at, last_seen_at, step_up_at, user_agent, country, asn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(sessionId, c.tokenHash, c.challengeHash, c.orgId, r.seat_id, c.credentialId, now, now, now, c.userAgent, c.country, c.asn),
    ]]
  })
  return outcome as 'denied' | 'lapsed' | 'completed'
}

/** The completed recovery that suspended this passkey: the passkey is on an Owner seat and its stop right date is the completion date plus 7 days (a re-enrolment could give another seat's passkey the same date). An override suspends nothing. */
export const recoveryToStop = async (db: D1Database, c: StoredCredential) => (c.stop_right_until === null ? null
  : db.prepare(`SELECT r.id, r.seat_id, r.closed_at, r.undo FROM recovery_requests r JOIN seats s ON s.org_id = r.org_id AND s.id = ? AND s.role = 'owner'
                WHERE r.org_id = ? AND r.state = 'completed' AND r.closed_at + ${STOP_MS} = ?`).bind(c.seat_id, c.org_id, c.stop_right_until).first<{ id: string; seat_id: string; closed_at: number; undo: string | null }>())

/** Frozen seats, with who froze each and when: read from the audit rows. A stop is a freeze by the seat's own replaced passkey. */
export async function frozenSeats(db: D1Database, orgId: string, seatId: string | null = null) {
  const { results } = await db
    .prepare(`SELECT s.id, s.display_name AS name, f.display_name AS by, a.at, a.action FROM seats s
              LEFT JOIN audit_log a ON a.org_id = s.org_id AND a.seq = (SELECT max(x.seq) FROM audit_log x WHERE x.org_id = s.org_id
                AND ((x.action = 'seat.freeze' AND x.subject_id = s.id) OR (x.action = 'credential.stop' AND x.actor_id = s.id)))
              LEFT JOIN seats f ON f.org_id = a.org_id AND f.id = a.actor_id
              WHERE s.org_id = ? AND s.state = 'frozen' AND (? IS NULL OR s.id = ?) ORDER BY s.created_at, s.id`)
    .bind(orgId, seatId, seatId).all<{ id: string; name: string; by: string | null; at: number | null; action: string | null }>()
  return results.map((seat) => ({ id: seat.id, name: seat.name, by: seat.by, at: seat.at, stopped: seat.action === 'credential.stop' }))
}

// ---- the audit log, as its readers see it: names instead of ids, newest first ----

export interface AuditLine { seq: number; at: number; action: string; detail: string | null; who: string | null; target: string | null; prevHash: string; hash: string }
/** One page before `before`, newest first; or, with `after` (the export), the rows after it and before `before`, oldest first. */
// Read by the key (org_id, seq), so a page reads its own rows and their names only, each name by an index (approvals by
// subject: 0020).
export async function auditRows(db: D1Database, actor: Actor, before: number | null, limit: number, after: number | null = null) {
  const named = (table: string, seat: string) => `(SELECT n.display_name FROM ${table} x JOIN seats n ON n.org_id = x.org_id AND n.id = x.${seat} WHERE x.org_id = a.org_id AND x.id = a.subject_id)`
  const { results } = await db
    .prepare(`SELECT a.seq, a.at, a.action, a.detail, a.prev_hash AS prevHash, a.hash,
                     COALESCE(w.display_name, (SELECT CASE WHEN a.action LIKE 'order.%' THEN 'Wallet ' ELSE 'Recovery wallet ' END || x.label FROM wallets x WHERE x.org_id = a.org_id AND x.id = a.actor_id AND a.actor_kind = 'anchor')) AS who,
                     COALESCE(t.display_name, ${named('credentials', 'seat_id')}, ${named('enrolment_tickets', 'seat_id')}, ${named('sessions', 'seat_id')}, ${named('approvals', 'subject_id')}, ${named('recovery_requests', 'seat_id')},
                       (SELECT x.label FROM wallets x WHERE x.org_id = a.org_id AND x.id = a.subject_id),
                       (SELECT 'ORD-' || substr(x.id, 1, 8) FROM approvals x WHERE x.org_id = a.org_id AND x.id = a.subject_id AND x.action = 'order'),
                       (SELECT 'ORD-' || substr(x.id, 1, 8) FROM approvals x WHERE x.org_id = a.org_id AND x.subject_id = a.subject_id AND x.action = 'order')) AS target
              FROM audit_log a LEFT JOIN seats w ON w.org_id = a.org_id AND w.id = a.actor_id LEFT JOIN seats t ON t.org_id = a.org_id AND t.id = a.subject_id
              WHERE a.org_id = ? AND a.seq < ? AND a.seq > ? ORDER BY a.seq ${after === null ? 'DESC' : 'ASC'} LIMIT ?`)
    .bind(actor.orgId, before ?? Number.MAX_SAFE_INTEGER, after ?? 0, limit).all<AuditLine>()
  return results
}
// The export, in pages of EXPORT_PAGE rows (the Free plan's share of rows read a request) that the page fetches in order
// and saves as one file. The first call writes the export's row first: if that fails, no file leaves. The file holds
// every row up to that one, which is its last. A later page is given only for an export row of the same session.
export const EXPORT_PAGE = 500
export async function exportAudit(db: D1Database, actor: Actor, now: number, after: number | null, upto: number | null) {
  if (upto === null) {
    await commit(db, actor.orgId, () => [seatEntry(actor, now, 'audit.export', null), []])
    upto = (await db.prepare(`SELECT seq FROM audit_log WHERE org_id = ? AND action = 'audit.export' AND session_id = ? ORDER BY seq DESC LIMIT 1`).bind(actor.orgId, actor.sessionId).first<{ seq: number }>())!.seq
  } else if (!(await db.prepare(`SELECT 1 FROM audit_log WHERE org_id = ? AND seq = ? AND action = 'audit.export' AND session_id = ?`).bind(actor.orgId, upto, actor.sessionId).first())) return null
  const rows = await auditRows(db, actor, upto + 1, EXPORT_PAGE, after ?? 0)
  return { rows, upto, next: rows.length === EXPORT_PAGE && rows.at(-1)!.seq < upto ? rows.at(-1)!.seq : null }
}

// ---- alerts: no email exists, so a member is told at sign-in (recovery.md section 1) ----

export interface Alert {
  key: string; kind: string; at?: number | null; until?: number; name?: string; by?: string | null; stopped?: boolean; what?: string; detail?: string | null; mine?: boolean
  /** An open recovery request: its id and nonce, whether it overrides the Owners, whether someone objected, when it lapses, and what this member may do. */
  id?: string; nonce?: string; override?: boolean; objected?: boolean; lapses?: number; may?: 'cancel' | 'object' | null
}
// ponytail: alerts are read from the rows of the last 7 days on each /api/me; the server keeps no "seen"
// mark (the browser remembers what was read). Add a table if an alert must be acknowledged by name.
export async function alertsFor(db: D1Database, actor: Actor, now: number) {
  const since = now - ALERT_MS
  const [tickets, added, closed, changed] = await db.batch([
    // The member's own re-enrolments, and every confirmed ticket of a colleague that this member did not issue.
    db.prepare(`SELECT t.id, t.kind, t.state, t.seat_id, t.created_at, s.display_name FROM enrolment_tickets t JOIN seats s ON s.org_id = t.org_id AND s.id = t.seat_id
                WHERE t.org_id = ? AND t.created_at > ? AND ((t.kind = 're_enrolment' AND t.seat_id = ?) OR (t.state = 'confirmed' AND t.seat_id <> ? AND t.issuer_seat_id <> ?))
                ORDER BY t.created_at, t.id`).bind(actor.orgId, since, actor.seatId, actor.seatId, actor.seatId),
    db.prepare(`SELECT subject_id, at FROM audit_log WHERE org_id = ? AND actor_id = ? AND action = 'credential.add' AND at > ? AND session_id <> ? ORDER BY seq`).bind(actor.orgId, actor.seatId, since, actor.sessionId),
    // "The issuer is flagged": a sign-in that closed a re-enrolment is shown to the people who can issue one.
    db.prepare(`SELECT a.subject_id AS id, a.at, s.display_name FROM audit_log a JOIN seats s ON s.org_id = a.org_id AND s.id = a.actor_id
                WHERE a.org_id = ? AND a.action = 'session.create' AND a.detail = 'ticket_killed' AND a.at > ? AND a.actor_id <> ? AND ? = 1 ORDER BY a.seq`).bind(actor.orgId, since, actor.seatId, seesAll(actor)),
    // What two people changed: told to every member but the one who approved it.
    db.prepare(`SELECT a.seq, a.at, a.action, a.detail, a.subject_id, COALESCE(s.display_name, (SELECT x.label FROM wallets x WHERE x.org_id = a.org_id AND x.id = a.subject_id)) AS display_name
                FROM audit_log a LEFT JOIN seats s ON s.org_id = a.org_id AND s.id = a.subject_id
                WHERE a.org_id = ? AND a.at > ? AND a.actor_id <> ? AND a.action IN ('seat.unfreeze', 'seat.remove', 'seat.role', 'policy.synced_keys', 'wallet.link', 'anchor.set', 'recovery.stop') AND a.detail IS NOT 'invited' ORDER BY a.seq`).bind(actor.orgId, since, actor.seatId),
  ])
  // Account recovery: the open request, for every member and at every sign-in (the key holds the session), and what became of each request closed in the last 7 days.
  const recoveries = (await db.prepare(`SELECT r.id, r.action, r.state, r.wait_until, r.objected, r.nonce, r.created_at, r.closed_at FROM recovery_requests r
                                        WHERE r.org_id = ? AND ((${OPEN_RECOVERY}) OR r.closed_at > ?) ORDER BY r.created_at, r.id`).bind(actor.orgId, now, since)
    .all<{ id: string; action: string; state: string; wait_until: number; objected: number; nonce: string; created_at: number; closed_at: number | null }>()).results
  const requests = KEY_ROLES.includes(actor.role) ? (await openRequests(db, actor, now)).filter((request) => !request.mine) : []
  const waiting = (await openTickets(db, actor, now)).filter((t) => t.myStep)
  return [
    ...recoveries.map((r) => {
      const override = r.action === 'override_owners'
      if (r.state !== 'waiting') return { key: `recovery:${r.id}:${r.state}`, kind: `recovery_${r.state}`, at: r.closed_at, override }
      const may = actor.role === 'owner' ? (override ? null : ('cancel' as const)) : KEY_ROLES.includes(actor.role) && !r.objected && r.wait_until > now ? ('object' as const) : null
      return { key: `recovery:${r.id}:${r.objected}:${actor.sessionId}`, kind: 'recovery', id: r.id, nonce: r.nonce, at: r.created_at, until: r.wait_until, lapses: r.wait_until + READY_MS, override, objected: r.objected === 1, may }
    }),
    ...(quarantined(actor, now) ? [{ key: `quarantine:${actor.quarantineUntil}`, kind: 'quarantine', until: actor.quarantineUntil! }] : []),
    ...(tickets.results as { id: string; kind: string; state: string; seat_id: string; created_at: number; display_name: string }[]).map((t) =>
      t.seat_id !== actor.seatId ? { key: `re:${t.id}`, kind: t.kind === 're_enrolment' ? 'colleague_re_enrolled' : 'colleague_joined', at: t.created_at, name: t.display_name }
      : { key: `re:${t.id}:${t.state}`, kind: t.state === 'confirmed' ? 're_enrolment_completed' : 're_enrolment_started', at: t.created_at }),
    ...(added.results as { subject_id: string; at: number }[]).map((c) => ({ key: `key:${c.subject_id}`, kind: 'new_passkey', at: c.at })),
    ...(await frozenSeats(db, actor.orgId)).map((seat) => ({ key: `frozen:${seat.id}:${seat.at}`, kind: 'seat_frozen', name: seat.name, by: seat.by, at: seat.at, stopped: seat.stopped })),
    ...(closed.results as { id: string; at: number; display_name: string }[]).map((s) => ({ key: `closed:${s.id}`, kind: 're_enrolment_closed', at: s.at, name: s.display_name })),
    ...waiting.map((t) => ({ key: `wait:${t.id}:${t.myStep}`, kind: 'confirmation_waiting', name: t.name })),
    ...requests.map((request) => ({ key: `request:${request.id}`, kind: 'approval_waiting', name: request.requester })),
    ...(changed.results as { seq: number; at: number; action: string; detail: string | null; subject_id: string; display_name: string | null }[]).map((c) =>
      ({ key: `change:${c.seq}`, kind: 'changed', what: c.action, detail: c.detail, at: c.at, name: c.display_name ?? '', mine: c.subject_id === actor.seatId })),
  ] satisfies Alert[]
}

// ---- local development only: no route calls these ----

/** One organisation, its first Owner seat and a one-time enrolment ticket (10 minutes: a key role). */
export async function seedOrganisation(db: D1Database, o: { name: string; kind: 'partner' | 'institution'; ownerName: string; ticketHash: string; now: number; domain?: string }) {
  const orgId = randomId()
  const seatId = randomId()
  const ticketId = randomId()
  await commit(db, orgId, () => [{ at: o.now, actorKind: 'system', actorId: null, sessionId: null, action: 'organisation.seed', subjectId: orgId }, [
    // The country is a constant of the seed: the KYB row of a screening copies it (kyb_records needs one).
    db.prepare(`INSERT INTO organisations (id, kind, name, state, created_at, email_domain, country) VALUES (?, ?, ?, 'active', ?, ?, 'LU')`)
      .bind(orgId, o.kind, o.name, o.now, o.domain ?? null),
    db.prepare(`INSERT INTO seats (id, org_id, display_name, role, state, created_at) VALUES (?, ?, ?, 'owner', 'invited', ?)`).bind(seatId, orgId, o.ownerName, o.now),
    db.prepare(`INSERT INTO enrolment_tickets (id, org_id, seat_id, kind, role, token_hash, state, expires_at, created_at)
                VALUES (?, ?, ?, 'first_owner', 'owner', ?, 'issued', ?, ?)`).bind(ticketId, orgId, seatId, o.ticketHash, o.now + 10 * 60_000, o.now),
  ]])
  return { orgId, seatId }
}

// ponytail: local only ("seed --demo"). A linked wallet named "Demo wallet" that no signature proved, so that one
// person can try the order ticket. A real wallet is linked by its own signature (milestone 4a). Its address is random
// (nobody holds its key) unless given: "seed --demo" gives the first public test key of anvil, which signs locally against the stand-in orderbook. "seed --live" gives the address instead: the partner wallet of the indexer's
// contract file, whose figures the local stand-in answers. "seed --demo" also links a "Demo Safe" (kind safe, a random
// address), whose orders the end-to-end run sends as presign orders. It must never see a real database.
export async function devDemoWallet(db: D1Database, environment: string, orgId: string, now: number, address = `0x${randomId()}${randomId().slice(0, 8)}`, kind: 'custodian' | 'safe' = 'custodian', label = 'Demo wallet') {
  if (environment !== 'local') throw new Error('refused: the demo wallet is for the local database only')
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('refused: not an address in lower case')
  const id = randomId()
  await commit(db, orgId, () => [{ at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'wallet.link', subjectId: id, detail: 'demo' }, [
    db.prepare(`INSERT INTO wallets (id, org_id, chain_id, address, kind, label, state, proof_nonce, proof_digest, proof_signature, proof_checked_at, linked_at)
                VALUES (?, ?, 10, ?, ?, ?, 'linked', ?, '0x', '0x', ?, ?)`).bind(id, orgId, address, kind, label, `demo-${id}`, now, now),
  ]])
  return id
}

// ponytail: stands in for the first Owner's activation, which the recovery anchor confirms in milestone 4
// (recovery.md section 3). It activates every pending passkey of a ticket, so it must never see a real database.
// The pending passkey of a recovery request has no ticket and is never activated here.
export async function devActivatePending(db: D1Database, environment: string, now: number) {
  if (environment !== 'local') throw new Error('refused: activation by command is for the local database only')
  const { results } = await db.prepare(`SELECT id, org_id, seat_id, ticket_id FROM credentials WHERE state = 'pending' AND ticket_id IS NOT NULL`).all<{ id: string; org_id: string; seat_id: string; ticket_id: string | null }>()
  for (const c of results) {
    await commit(db, c.org_id, () => [{ at: now, actorKind: 'system', actorId: null, sessionId: null, action: 'credential.activate.dev', subjectId: c.id }, [
      db.prepare(`UPDATE credentials SET state = 'active' WHERE org_id = ? AND id = ? AND state = 'pending'`).bind(c.org_id, c.id),
      db.prepare(`UPDATE seats SET state = 'active', ophis_approved = 0 WHERE org_id = ? AND id = ? AND state = 'invited'`).bind(c.org_id, c.seat_id),
      db.prepare(`UPDATE enrolment_tickets SET state = 'confirmed' WHERE org_id = ? AND id = ?`).bind(c.org_id, c.ticket_id),
    ]])
  }
  return results.length
}

// ponytail: stands in for the passing of time, for the local end-to-end flow: every wait that runs is over (a
// recovery wallet's 72 hours, a recovery request's wait, the 24 hours after a cancel). No audit row. Local database only.
export async function devSkipWaits(db: D1Database, environment: string, now: number) {
  if (environment !== 'local') throw new Error('refused: skipping waits is for the local database only')
  await db.batch([
    db.prepare(`UPDATE wallets SET anchor_effective_at = ? WHERE anchor = 'next' AND anchor_effective_at > ?`).bind(now, now),
    db.prepare(`UPDATE recovery_requests SET wait_until = ? WHERE state = 'waiting' AND wait_until > ?`).bind(now, now),
    db.prepare(`UPDATE recovery_requests SET closed_at = ? WHERE state = 'cancelled' AND closed_at > ?`).bind(now - DAY, now - DAY),
  ])
}

// ponytail: stands in for the passing of 5 minutes, for the local end-to-end flow: every passkey check is stale, so
// the next sensitive step asks for the passkey again. Sessions stay signed in. No audit row. Local database only.
export async function devStaleChecks(db: D1Database, environment: string) {
  if (environment !== 'local') throw new Error('refused: ageing passkey checks is for the local database only')
  await db.prepare('UPDATE sessions SET step_up_at = 0').run()
}
