// Milestone 5a: how an organisation comes to exist and becomes active (recovery.md section 3).
//   /apply            a company applies with an invitation code: its details and the first Owner's passkey
//   Onboarding        the Owner names the recovery wallet (which signs) or enrols a second Owner, submits
//   operator's API    on its own hostname: the KYB decision, freeze and unfreeze; each a row in the client's own audit log
// This file holds its own handlers and, in its first half, its own rows: every statement is prepared with bound
// parameters, and every change goes through commit() of the data module, with what decides it read inside the plan.
import { checksum, colour, parseAddress, readCapped, safeState, verify, verifyDigest, type SafeState } from './chain.ts'
import { commit, DOMAIN, emailAt, freezing, gone, LISTED, listed, listedWallet, SINGLE_KEY_RECOVERY, randomId, REVIEWED, sha256Hex, type Actor, type WalletKind } from './data.ts'
import { challengeIsOurs, creationOptions, credentialHash, fromBase64Url, newChallenge, seal, unseal, verifyRegistration, type Config } from './passkeys.ts'
import { indexerBase } from './partner.ts'
import { standIn } from './orders.ts'
import { CHAIN_NAME, LISTS, typedProof } from './typed.ts'

// Constants per environment, like those of passkeys.ts, and never read from a request.
// The operator's API has a hostname of its own, as the signing page has. In production Cloudflare Access stands in front of it (accessOk).
export const OPERATOR: Record<string, string> = { local: 'http://operator.localhost:8787', production: 'https://operator.ophis.fi' }

const WEEK_S = 7 * 24 * 60 * 60
const DUE_MS = 14 * 24 * 60 * 60 * 1000 // a review is due from 14 days before its date
const INVITE_MS = 48 * 60 * 60 * 1000 // an invitation code lives 48 hours (owner, 2026-11-17)
const MAX_BODY = 64 * 1024
const ID = /^[0-9a-f]{32}$/
const LABEL = /^[\p{L}\p{N} ._()-]{1,40}$/u
export const REASONS = ['entity_not_found', 'details_differ', 'authority_unclear', 'wallet_differs', 'declaration_needed', 'not_eligible'] as const
export const SOURCES = ['registry', 'gleif', 'supervisor_register', 'declaration'] as const
const TIERS = ['standard', 'enhanced']
// Sanctions screening: manual, at no cost. The operator downloads the official lists, searches them offline and records
// the result with its command. The server holds, per organisation only: the outcome, which lists, the SHA-256 of each
// list file searched, the date. No name of a person, no detail of a hit and no list file reaches it, and the Worker
// calls no outside service. The codes of the lists, with the names the pages show: LISTS (typed.ts).
export { LISTS }
const OUTCOMES = ['clear', 'review', 'hit']
const SHA256 = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
// Of one list. The rows of D1 Free are counted per day: a load writes about 3 rows an address (the old one out, the
// new one in with its index entry) and every partner page reads the addresses of all three lists. 1,000 keeps both
// in a few thousand; the OFAC EVM list held 127 on 2026-11-13. 1,000 addresses are about 45 KB of JSON: the 64 KB of a body.
export const MAX_ADDRESSES = 1_000
const CHUNK = 99 // D1 binds at most 100 values per statement: the list code and 99 addresses
// M10: the OFAC list as a file the console reads (SANCTIONS_URL; made by scripts/ofac-list.mjs). One GET, 5 seconds, 2 MB.
// hold: a file that adds more than a fifth of the loaded addresses is not loaded, nor one that lacks any (a removal waits for a person). staleMs: no good read, or a file made, for 3 days is said to the operator.
// manualMs: with no file set (production, owner 2026-11-15), the OFAC list is loaded by hand once a month; 35 days after that load it is stale.
export const FEED = { timeoutMs: 5000, maxBytes: 2_000_000, hold: 0.2, staleMs: 3 * 24 * 60 * 60 * 1000, manualMs: 35 * 24 * 60 * 60 * 1000 }
/** The day a list file was published, YYYY-MM-DD: a real day, not after tomorrow. */
const publishedOk = (value: unknown, now: number): value is string => {
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN
  return ms <= now + 24 * 60 * 60 * 1000 && new Date(ms).toISOString().slice(0, 10) === value
}
/** The time the maker made a list file, YYYY-MM-DDTHH:MM:SSZ (UTC, to the second): a real time, not more than a day ahead. */
const madeOk = (value: unknown, now: number): value is string => {
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ? Date.parse(value) : NaN
  return ms <= now + 24 * 60 * 60 * 1000 && `${new Date(ms).toISOString().slice(0, 19)}Z` === value
}
/** The addresses of one load, checked: 1 to 1,000, each 0x and 40 hex characters in lower case, none twice. */
const listable = (addresses: unknown): addresses is string[] => Array.isArray(addresses) && addresses.length >= 1 && addresses.length <= MAX_ADDRESSES
  && addresses.every((address) => typeof address === 'string' && ADDRESS.test(address)) && new Set(addresses).size === addresses.length

// The words of this file's audit actions, for the audit page and the export (spread into EVENTS of index.ts).
export const ONBOARDING_EVENTS: Record<string, string> = {
  'organisation.apply': 'Organisation created by an application, first Owner passkey active',
  // Written from 2026-11-17 until 2026-11-18 ("Create the organisation" without the DNS record); production holds one. Read, never written.
  'organisation.apply_unproved': 'Organisation created by an application without a DNS proof of its domain, first Owner passkey active',
  'activation.proof': 'Recovery wallet signed the activation and confirmed the first Owner passkey',
  'review.submit': 'Organisation submitted for review',
  // Written by hand by the operator, at the first Owner's request (2026-11-19: the legal details of an application were placeholders). Read, never written by code.
  'organisation.correct': 'Ophis operator: legal name, registration number and registered address corrected, at the request of the first Owner',
  'declaration.upload': 'Signed declaration uploaded, sealed in the browser (the detail is the SHA-256 of the sealed file)',
  'kyb.approve': 'Ophis operator: verification approved, organisation active, with the people its application named',
  'kyb.refuse': 'Ophis operator: verification refused, organisation closed',
  'kyb.more': 'Ophis operator: more information asked, the review was sent back',
  // The outcome is the detail of the row. Only "clear" has words of its own (index.ts): no other outcome is said to a browser.
  'kyb.screen': 'Ophis operator: sanctions screening recorded, organisation frozen',
  'sealed.download': 'Ophis operator: downloaded the sealed declaration, still sealed',
  'organisation.freeze': 'Ophis operator: organisation frozen',
  'organisation.unfreeze': 'Ophis operator: organisation unfrozen',
  // The operator's load (actor operator) or the daily read of the list file (actor system): the words are true for both.
  'screening.wallet': 'A wallet of the organisation is on a loaded sanctions list, organisation frozen',
  // A wallet proved its control of an address that is on a loaded list. An active organisation is frozen by it (data.ts); one that is not yet verified is not.
  'screening.attempt': 'Link of a wallet refused: its address is on a loaded sanctions list. Organisation frozen',
  'screening.refused': 'Recovery wallet of the application refused: its address is on a loaded sanctions list',
}
const KYB_ACTION = { approve: 'kyb.approve', refuse: 'kyb.refuse', more: 'kyb.more' } as const
type Decision = keyof typeof KYB_ACTION

const json = (status: number, body: unknown) => Response.json(body, { status })
const fail = (status: number, error: string) => json(status, { error })
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403 }
const refuse = (error: string) => fail(STATUS[error] ?? 409, error)
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

// ---- rows ----

// deviceBound: absent in an intent sealed before 2026-11-17, when an applicant's passkey had to be a hardware key.
interface Passkey { id: string; publicKey: string; counter: number; transports: string[]; deviceBound?: boolean }
/** One more person the application names (owner decision of 2026-11-13): Ophis approves them with the organisation. */
// position, phone and telegram (0026): how Ophis reaches each person; telegram is optional. An intent sealed before
// 2026-11-17 (7 days at most) has none of the new fields: they are stored as NULL.
interface Contact { position: string; phone: string; telegram: string | null }
interface Person extends Contact { name: string; email: string; role: 'owner' | 'admin' }
interface Applicant extends Contact { businessType: string; legalName: string; country: string; registration: string; lei: string | null; address: string; kind: 'partner' | 'institution'; domain: string; email: string; name: string; people: Person[] }
/** What /apply asked for, signed by the server and held nowhere: nothing is written before "Create the organisation". Times are Unix seconds. */
interface ApplyIntent extends Applicant { inviteHash: string; seat: string; credential: Passkey; credentialHash: string; issuedAt: number; expiresAt: number; site: string }

// The one write of an application: the organisation (unverified), its first Owner seat, that
// seat's passkey (active), the other people it named (rows only: their seats come with the approval) and the first
// row of its audit log, which names the seat, the passkey and the passkey's hash for good. One organisation per domain among those that are not archived is the database's rule (the unique
// index of 0006), and so are "an intent makes one organisation, once" (the primary keys of its seat and passkey) and
// "an application code makes one organisation, once" (the unique index of 0007 on its hash).
// The domain is stored, not proved (owner, 2026-11-18: no DNS record; the invitation and Ophis's review stand for it).
async function createOrganisation(db: D1Database, a: ApplyIntent, now: number) {
  const orgId = randomId()
  let outcome = 'not_stored'
  try {
    await commit(db, orgId, () => {
      outcome = 'ok'
      return [{ at: now, actorKind: 'seat', actorId: a.seat, sessionId: null, action: 'organisation.apply', subjectId: a.credential.id, detail: a.credentialHash }, [
        db.prepare(`INSERT INTO organisations (id, kind, business_type, name, state, email_domain, country, registration_number, lei, registered_address, invite_hash, synced_keys_allowed, created_at)
                    VALUES (?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?, ?, 1, ?)`).bind(orgId, a.kind, a.businessType ?? null, a.legalName, a.domain, a.country, a.registration, a.lei ?? null, a.address ?? null, a.inviteHash, now),
        db.prepare(`INSERT INTO seats (id, org_id, display_name, email, role, state, position, phone, telegram, created_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?, ?)`)
          .bind(a.seat, orgId, a.name, a.email, a.position ?? null, a.phone ?? null, a.telegram ?? null, now),
        db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'First key', 'active', ?)`)
          .bind(a.credential.id, orgId, a.seat, a.credential.publicKey, a.credential.counter, a.credential.deviceBound === false ? 0 : 1, JSON.stringify(a.credential.transports), now),
        // An intent sealed before 2026-11-13 (7 days at most) has no `people`: it names nobody.
        ...(a.people ?? []).map((p) => db.prepare('INSERT INTO application_people (org_id, email, display_name, role, position, phone, telegram) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(orgId, p.email, p.name, p.role, p.position ?? null, p.phone ?? null, p.telegram ?? null)),
      ]]
    })
  } catch (error) {
    // What the database refuses (also at the same instant): this intent's seat or passkey exists, the domain is taken, or the code is used.
    if (!/UNIQUE constraint failed: (organisations\.(email_domain|invite_hash)|seats\.id|credentials\.id)/.test(String((error as Error)?.message))) throw error
    const seen = (await db.prepare(`SELECT (SELECT count(*) FROM seats WHERE id = ?) AS own, (SELECT count(*) FROM organisations WHERE email_domain = ? AND state <> 'archived') AS domain`).bind(a.seat, a.domain).first<{ own: number; domain: number }>())!
    return seen.own ? 'not_stored' : seen.domain ? 'domain_taken' : 'invite_used'
  }
  return outcome
}

/** The first Owner of an organisation that applied: the seat, the passkey and its hash from the first audit row, the organisation's state, whether that passkey is still active on that Owner seat, and the seat's name (for the declaration). */
interface First { seatId: string; hash: string; state: string; reviewAt: number | null; active: number; name: string; email: string; position: string | null; phone: string | null; telegram: string | null }
const firstOf = (db: D1Database, orgId: string) =>
  db.prepare(`SELECT a.actor_id AS seatId, a.detail AS hash, o.state, o.review_at AS reviewAt, f.display_name AS name, f.email, f.position, f.phone, f.telegram,
                     (SELECT count(*) FROM credentials k JOIN seats s ON s.org_id = k.org_id AND s.id = k.seat_id AND s.role = 'owner' AND s.state = 'active'
                      WHERE k.org_id = a.org_id AND k.id = a.subject_id AND k.seat_id = a.actor_id AND k.state = 'active') AS active
              FROM audit_log a JOIN organisations o ON o.id = a.org_id LEFT JOIN seats f ON f.org_id = a.org_id AND f.id = a.actor_id
              WHERE a.org_id = ? AND a.seq = 1 AND a.action IN ('organisation.apply', 'organisation.apply_unproved')`).bind(orgId).first<First>() // the second: ONBOARDING_EVENTS
/** The people the application named besides its applicant, in the order it gave them. */
const peopleOf = async (db: D1Database, orgId: string) =>
  (await db.prepare('SELECT display_name AS name, email, role, position, phone, telegram FROM application_people WHERE org_id = ? ORDER BY rowid').bind(orgId).all<Person>()).results

/**
 * A7: what a review needs, from the rows as they are now. An active passkey on the first Owner's seat (one is enough,
 * owner 2026-11-18; device-bound where the organisation requires hardware keys), and either the activation proof (a
 * wallet stored as pending, while the passkey it confirmed is still active) or a second Owner with one. Recovery
 * eligibility is separate: a valid activation proof can support review without becoming a recovery wallet.
 * Milestone 5b: and the signed declaration, sealed. Null: it holds.
 * Read when the Owner submits and again when the operator approves.
 */
async function missing(db: D1Database, orgId: string): Promise<null | 'not_found' | 'owner_key' | 'proof_or_owner' | 'declaration'> {
  const first = await firstOf(db, orgId)
  if (!first) return 'not_found'
  const owner = `s.org_id = ?1 AND s.role = 'owner' AND s.state = 'active' AND (SELECT count(*) FROM credentials k WHERE k.org_id = s.org_id AND k.seat_id = s.id AND k.state = 'active' AND (k.device_bound = 1 OR (SELECT synced_keys_allowed FROM organisations WHERE id = s.org_id) = 1)) >= 1`
  const seen = (await db.prepare(`SELECT (SELECT count(*) FROM seats s WHERE ${owner} AND s.id = ?2) AS own, (SELECT count(*) FROM seats s WHERE ${owner} AND s.id <> ?2) AS others,
                                         (SELECT count(*) FROM wallets w WHERE w.org_id = ?1 AND w.state = 'pending') AS proof,
                                         (SELECT count(*) FROM sealed_items i WHERE i.org_id = ?1 AND i.kind = 'declaration') AS declared`)
    .bind(orgId, first.seatId).first<{ own: number; others: number; proof: number; declared: number }>())!
  return !seen.own ? 'owner_key' : !((seen.proof && first.active) || seen.others) ? 'proof_or_owner' : !seen.declared ? 'declaration' : null
}

interface Proved { orgId: string; seatId: string; chainId: number; address: string; kind: WalletKind; label: string; snapshot: string | null; credentialHash: string; nonce: string; digest: string; signature: string; by: 'key' | 'contract' }
// A valid activation proof arrived. One commit: the organisation is still unverified, the seat that asked for it (G2:
// the intent names it) is still an active Owner, the passkey the wallet confirmed is still the first Owner's and active, the proof was never accepted (proof_nonce is unique and rows stay). The wallet
// is stored as pending with its proof and replaces an earlier one. No approval request: the operator's decision is the
// second check. A new proof is a new thing to review, so an organisation under review is no longer submitted: commit()
// sees that the wallet differs from the one that was submitted (G3).
async function storeProof(db: D1Database, w: Proved, now: number) {
  const id = randomId()
  let outcome = 'not_unverified'
  await commit(db, w.orgId, async () => {
    const first = await firstOf(db, w.orgId)
    const asker = await db.prepare(`SELECT 1 FROM seats WHERE org_id = ? AND id = ? AND role = 'owner' AND state = 'active'`).bind(w.orgId, w.seatId).first()
    outcome = first?.state !== 'unverified' ? 'not_unverified' : !asker ? 'forbidden' : !first.active || first.hash !== w.credentialHash ? 'first_passkey_gone'
      : (await db.prepare('SELECT 1 FROM wallets WHERE proof_nonce = ?').bind(w.nonce).first()) ? 'proof_used' : (await listed(db, w.address)) ? 'wallet_listed' : 'stored'
    // A proven wallet at a listed address: refused, with one row in the organisation's log per address (an organisation that is not yet verified is never frozen).
    if (outcome === 'wallet_listed' && !(await db.prepare(`SELECT 1 FROM audit_log WHERE org_id = ? AND action = 'screening.refused' AND detail = ?`).bind(w.orgId, w.address).first())) {
      return [{ at: now, actorKind: 'seat', actorId: w.seatId, sessionId: null, action: 'screening.refused', subjectId: null, detail: w.address }, []]
    }
    if (outcome !== 'stored') return null
    return [{ at: now, actorKind: 'anchor', actorId: id, sessionId: null, action: 'activation.proof', subjectId: id, detail: w.kind }, [
      db.prepare(`UPDATE wallets SET state = 'unlinked' WHERE org_id = ? AND state = 'pending'`).bind(w.orgId),
      db.prepare(`INSERT INTO wallets (id, org_id, chain_id, address, kind, label, state, proof_nonce, proof_digest, proof_signature, proof_by, proof_checked_at, linked_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, w.orgId, w.chainId, w.address, w.kind, w.label, w.nonce, w.digest, w.signature, w.by, now, now, w.snapshot),
    ]]
  })
  return outcome
}

/** Inside a commit: the organisation's state, if this actor is still an active Owner there with this session. */
const ownerNow = (db: D1Database, actor: Actor) =>
  db.prepare(`SELECT o.state, o.review_at AS reviewAt FROM seats s JOIN sessions x ON x.org_id = s.org_id AND x.seat_id = s.id AND x.id = ? AND x.revoked_at IS NULL
              JOIN organisations o ON o.id = s.org_id WHERE s.org_id = ? AND s.id = ? AND s.state = 'active' AND s.role = 'owner'`)
    .bind(actor.sessionId, actor.orgId, actor.seatId).first<{ state: string; reviewAt: number | null }>()

// "Submit for review": the Owner, the session and the organisation's state are read inside the commit, and so is A7.
// G3: it also stores what the operator will compare (REVIEWED): any later change to it un-submits the organisation.
async function submitForReview(db: D1Database, actor: Actor, now: number) {
  let outcome = 'forbidden'
  await commit(db, actor.orgId, async () => {
    const who = await ownerNow(db, actor)
    outcome = !who ? 'forbidden' : who.state !== 'unverified' ? 'not_unverified' : who.reviewAt !== null ? 'already_submitted' : (await missing(db, actor.orgId)) ?? 'ok'
    if (outcome !== 'ok') return null
    return [{ at: now, actorKind: 'seat', actorId: actor.seatId, sessionId: actor.sessionId, action: 'review.submit', subjectId: actor.orgId, country: actor.country, asn: actor.asn },
      [db.prepare(`UPDATE organisations SET review_at = ?2, review_print = ${REVIEWED} WHERE id = ?1`).bind(actor.orgId, now)]]
  })
  return outcome
}

interface WalletRow { id: string; chainId: number; address: string; kind: WalletKind; label: string; snapshot: string | null; digest: string; signature: string; inForce: number; recoveryEligible: number }
// The wallet of the onboarding: the proved one that waits for the review, or, once the organisation is active, its recovery wallet.
const walletOf = (db: D1Database, orgId: string, now: number) =>
  db.prepare(`SELECT w.id, w.chain_id AS chainId, w.address, w.kind, w.label, w.snapshot, w.proof_digest AS digest, w.proof_signature AS signature, w.anchor IS NOT NULL AS inForce,
                     (w.kind <> 'single_key' OR ${SINGLE_KEY_RECOVERY('?1', '?2')}) AS recoveryEligible
              FROM wallets w JOIN organisations o ON o.id = w.org_id WHERE w.org_id = ?1 AND ((o.state = 'unverified' AND w.state = 'pending') OR (o.state <> 'unverified' AND w.anchor IS NOT NULL))
              ORDER BY w.rowid DESC LIMIT 1`).bind(orgId, now).first<WalletRow>()

interface Company { id: string; legalName: string; kind: string; businessType: string | null; state: string; country: string | null; registration: string | null; lei: string | null; address: string | null; domain: string | null; reviewAt: number | null; print: string | null }
const COMPANY = `id, name AS legalName, kind, business_type AS businessType, state, country, registration_number AS registration, lei, registered_address AS address, email_domain AS domain, review_at AS reviewAt, review_print AS print FROM organisations`
interface KybRow { legalName: string; registration: string | null; country: string; tier: string; source: string; evidenceSha256: string | null; decision: string; reason: string | null; decidedAt: number | null; nextReview: number | null }
/** The newest KYB row of one organisation (bind its id): the row that says how the organisation stands. */
const NEWEST = `FROM kyb_records WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
/** The organisation of this session and its newest KYB row: the result, never a document. */
async function reviewOf(db: D1Database, orgId: string) {
  const [company, record] = await db.batch([
    db.prepare(`SELECT ${COMPANY} WHERE id = ?`).bind(orgId),
    db.prepare(`SELECT legal_name AS legalName, registration_number AS registration, country, tier, source, evidence_sha256 AS evidenceSha256, decision, reason, decided_at AS decidedAt, recheck_at AS nextReview ${NEWEST}`).bind(orgId),
  ])
  return { company: company.results[0] as Company, record: (record.results[0] as KybRow | undefined) ?? null }
}
// S4: the reviews that are due, for the operator's list: the active and frozen organisations whose newest record holds
// no screening (or that have no record), or whose next review date is passed or within 14 days; and every frozen
// organisation, whatever its dates. A frozen one says WHY: the newest row of its log among the actions that freeze (the
// operator's freeze, a wallet on a list, a proven attempt to link a listed address, a screening that says review or
// hit), with the address of its wallet when the row carries no detail. A later clear screening does not hide it.
// An active organisation carries none. The calendar is a manual chore.
// ponytail: the whole list at each call. Page it when the organisations pass some hundreds.
const reviewsDue = async (db: D1Database, now: number) =>
  (await db.prepare(`SELECT o.id, o.name, o.state, k.screening_outcome AS outcome, k.screened_at AS screenedAt, k.recheck_at AS nextReview, e.action AS lastAction,
                            COALESCE(e.detail, (SELECT w.address FROM wallets w WHERE w.org_id = e.org_id AND w.id = e.subject_id)) AS lastDetail, e.at AS lastAt
                     FROM organisations o LEFT JOIN kyb_records k ON k.rowid = (SELECT rowid FROM kyb_records WHERE org_id = o.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
                     LEFT JOIN audit_log e ON o.state = 'frozen' AND e.org_id = o.id AND e.seq = (SELECT max(seq) FROM audit_log WHERE org_id = o.id
                       AND (action IN ('organisation.freeze', 'screening.wallet', 'screening.attempt') OR (action = 'kyb.screen' AND detail IN ('review', 'hit'))))
                     WHERE o.state = 'frozen' OR (o.state = 'active' AND (k.screening_outcome IS NULL OR k.recheck_at <= ?)) ORDER BY o.name, o.id`).bind(now + DUE_MS).all()).results
/** R3: the addresses of the wallets an organisation named that were refused as listed, from its own log. */
const refusedOf = async (db: D1Database, orgId: string) =>
  (await db.prepare(`SELECT detail FROM audit_log WHERE org_id = ? AND action = 'screening.refused' ORDER BY seq`).bind(orgId).all<{ detail: string }>()).results.map((row) => row.detail)
// Every organisation, for the operator's page (owner, 2026-11-19): the approved ones too, which no other field lists.
// Under review: submitted and waiting for a decision; applying: not submitted yet. Members: the active seats, less an Owner seat
// a recovery replaced for good (data.ts, gone; CodeRabbit, PR #1672).
// ponytail: the whole list in one D1 query at each call. Page it when the organisations pass some hundreds.
const everyOrganisation = async (db: D1Database, now: number) =>
  (await db.prepare(`SELECT o.id, o.name, o.kind, o.country, k.recheck_at AS nextReview, (SELECT count(*) FROM seats s WHERE s.org_id = o.id AND s.state = 'active' AND NOT ${gone('s')}) AS members,
                            CASE WHEN o.state <> 'unverified' THEN o.state WHEN o.review_at IS NULL THEN 'applying' ELSE 'under review' END AS state
                     FROM organisations o LEFT JOIN kyb_records k ON k.rowid = (SELECT rowid FROM kyb_records WHERE org_id = o.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
                     ORDER BY o.name, o.id`).bind(now).all<{ id: string; name: string; kind: string; country: string | null; nextReview: number | null; members: number; state: string }>()).results
const underReview = async (db: D1Database) =>
  (await db.prepare(`SELECT ${COMPANY} WHERE state = 'unverified' AND review_at IS NOT NULL ORDER BY review_at, id`).all<Company>()).results

// An approval names the submitted facts and current recovery eligibility the operator saw; a change needs a fresh review.
const submissionOf = async (print: string | null, wallet: WalletRow | null) => (await sha256Hex(JSON.stringify([print ?? '', wallet?.recoveryEligible ?? null]))).slice(0, 16)
/** A screening as it is stored: the outcome, the lists as one JSON text (code to SHA-256 of the file searched, sorted keys) and the SHA-256 of that exact text. */
interface Screening { outcome: string; lists: string; hash: string }
interface Kyb { decision: Decision; submission: string | null; reason: string | null; tier: string; source: string; evidenceRef: string | null; evidenceSha256: string | null; nextReview: number | null; screening: Screening | null }
interface KybFields extends Omit<Kyb, 'decision' | 'submission'> { name: string; registration: string | null; country: string; decision: string; decidedAt: number | null }
// The one statement that writes a KYB row: the result of a review or of a screening, never a document. A screening is dated now.
const kybRow = (db: D1Database, id: string, orgId: string, k: KybFields, now: number) =>
  db.prepare(`INSERT INTO kyb_records (id, org_id, legal_name, registration_number, country, tier, source, evidence_ref, evidence_sha256, screening_outcome, screening_lists, screening_list_version_hash, screened_at,
                                       decision, decided_at, recheck_at, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, orgId, k.name, k.registration, k.country, k.tier, k.source, k.evidenceRef, k.evidenceSha256, k.screening?.outcome ?? null, k.screening?.lists ?? null, k.screening?.hash ?? null, k.screening ? now : null,
      k.decision, k.decidedAt, k.nextReview, k.reason, now)
// The operator's decision, in one commit with its row in the client's own audit log (actor kind "operator"). Read
// inside the plan, all of it again: the organisation is unverified and under review (any change to its Owner seats,
// their passkeys or the named wallet since the submit has taken it out of review: G3), for an approval the submission
// is the one the operator saw in the list (a change followed by a new submit is another one), A7 still holds,
// and the wallet the handler just checked on the chain is the wallet that waits now, by its id: else "try again". Approve: the organisation is active and that wallet is
// the recovery wallet in force at once, and each person the application named gets a seat, invited and marked as
// approved by Ophis (the operator names nobody: the rows of the application do). Refuse: archived. More information:
// back to the Owner. The KYB row copies the organisation's own name, number and country: the operator sets no field of
// the organisation, no member, no passkey and no wallet address.
async function decideKyb(db: D1Database, orgId: string, d: Kyb, checked: { id: string; snapshot: string | null } | null, now: number) {
  const id = randomId()
  let outcome = 'not_found'
  await commit(db, orgId, async () => {
    const o = await db.prepare('SELECT name, country, registration_number AS registration, state, review_at AS reviewAt, review_print AS print FROM organisations WHERE id = ?')
      .bind(orgId).first<{ name: string; country: string; registration: string | null; state: string; reviewAt: number | null; print: string | null }>()
    const wallet = d.decision === 'approve' ? await walletOf(db, orgId, now) : null
    outcome = !o ? 'not_found' : o.state !== 'unverified' || o.reviewAt === null ? 'not_under_review'
      : d.decision !== 'approve' ? 'ok' : (await missing(db, orgId)) ? 'not_ready' : (wallet?.id ?? null) !== (checked?.id ?? null) ? 'try_again'
      : (await submissionOf(o.print, wallet)) !== d.submission ? 'submission_changed' : (await listedWallet(db, orgId, now)) ? 'wallet_listed' : 'ok'
    if (outcome !== 'ok' || !o) return null
    const people = d.decision === 'approve' ? await peopleOf(db, orgId) : []
    return [{ at: now, actorKind: 'operator', actorId: null, sessionId: null, action: KYB_ACTION[d.decision], subjectId: id, detail: d.decision === 'approve' ? d.evidenceSha256 : d.reason }, [
      kybRow(db, id, orgId, { ...d, name: o.name, registration: o.registration, country: o.country, decision: { approve: 'approved', refuse: 'rejected', more: 'pending' }[d.decision], decidedAt: now }, now),
      db.prepare('UPDATE organisations SET state = ?, review_at = NULL WHERE id = ?').bind({ approve: 'active', refuse: 'archived', more: 'unverified' }[d.decision], orgId),
      // A verified personal wallet may link without gaining recovery authority over colleagues.
      ...(d.decision === 'approve' && checked ? [db.prepare(`UPDATE wallets SET state = 'linked', linked_at = ?, anchor = ?, anchor_effective_at = ?, snapshot = ? WHERE org_id = ? AND id = ? AND state = 'pending'`)
        .bind(now, wallet!.recoveryEligible ? 'current' : null, wallet!.recoveryEligible ? now : null, checked.snapshot, orgId, checked.id)] : []),
      ...people.map((p) => db.prepare(`INSERT INTO seats (id, org_id, display_name, email, role, state, ophis_approved, position, phone, telegram, created_at) VALUES (?, ?, ?, ?, ?, 'invited', 1, ?, ?, ?, ?)`)
        .bind(randomId(), orgId, p.name, p.email, p.role, p.position, p.phone, p.telegram, now)),
    ]]
  })
  return outcome
}

/** Inside a commit: what keeps a frozen organisation frozen. Its newest record says "review" or "hit" (a record with no screening blocks nothing), or a live wallet of it is on a loaded list. */
const blocked = async (db: D1Database, orgId: string, now: number) => {
  const newest = await db.prepare(`SELECT screening_outcome AS outcome ${NEWEST}`).bind(orgId).first<{ outcome: string | null }>()
  return newest?.outcome && newest.outcome !== 'clear' ? 'screening_not_clear' : (await listedWallet(db, orgId, now)) ? 'wallet_listed' : null
}
// Freeze: an active organisation only. An unverified one is never frozen: an unfreeze would make it active with no review.
// G4: a freeze ends every session of the organisation, in the same commit; an unfreeze brings none back.
async function setFrozen(db: D1Database, orgId: string, frozen: boolean, now: number) {
  let outcome = 'not_found'
  await commit(db, orgId, async () => {
    const o = await db.prepare('SELECT state FROM organisations WHERE id = ?').bind(orgId).first<{ state: string }>()
    outcome = !o ? 'not_found' : o.state !== (frozen ? 'active' : 'frozen') ? 'wrong_state' : (!frozen && (await blocked(db, orgId, now))) || 'ok'
    if (outcome !== 'ok') return null
    return [{ at: now, actorKind: 'operator', actorId: null, sessionId: null, action: frozen ? 'organisation.freeze' : 'organisation.unfreeze', subjectId: orgId },
      frozen ? freezing(db, orgId, now) : [db.prepare(`UPDATE organisations SET state = 'active' WHERE id = ? AND state = 'frozen'`).bind(orgId)]]
  })
  return outcome
}

// A screening of an organisation that is active or frozen, in one commit with its row in the client's own audit log
// (actor kind "operator", the outcome as detail). Read inside the plan: the organisation, whose name, number and
// country the new KYB row copies as a decision does, and its newest record, from which tier, source, evidence,
// decision and its date are carried on. An organisation with no record (a local seed) takes tier and source from the
// command, as approved now. "review" and "hit" freeze an active organisation in this commit, as the operator's freeze
// does; "clear" changes no state: a frozen organisation stays frozen until the operator unfreezes it.
async function recordScreening(db: D1Database, orgId: string, screening: Screening, nextReview: number, given: { tier?: string; source?: string }, now: number) {
  const id = randomId()
  let outcome = 'not_found'
  await commit(db, orgId, async () => {
    const o = await db.prepare('SELECT name, country, registration_number AS registration, state FROM organisations WHERE id = ?').bind(orgId).first<{ name: string; country: string | null; registration: string | null; state: string }>()
    const last = await db.prepare(`SELECT tier, source, evidence_ref AS evidenceRef, evidence_sha256 AS evidenceSha256, decision, decided_at AS decidedAt ${NEWEST}`).bind(orgId)
      .first<{ tier: string; source: string; evidenceRef: string | null; evidenceSha256: string | null; decision: string; decidedAt: number | null }>()
    const [tier, source] = [last?.tier ?? given.tier, last?.source ?? given.source]
    outcome = !o ? 'not_found' : o.state !== 'active' && o.state !== 'frozen' ? 'wrong_state' : !tier || !source || !o.country ? 'no_record' : screening.outcome === 'clear' ? o.state : 'frozen'
    if (!o?.country || !tier || !source || (outcome !== 'active' && outcome !== 'frozen')) return null
    return [{ at: now, actorKind: 'operator', actorId: null, sessionId: null, action: 'kyb.screen', subjectId: id, detail: screening.outcome }, [
      kybRow(db, id, orgId, { name: o.name, registration: o.registration, country: o.country, tier, source, evidenceRef: last?.evidenceRef ?? null, evidenceSha256: last?.evidenceSha256 ?? null, screening,
        decision: last?.decision ?? 'approved', decidedAt: last ? last.decidedAt : now, nextReview, reason: null }, now),
      ...(outcome === 'frozen' ? freezing(db, orgId, now) : []), // on an organisation that is frozen already these change nothing
    ]]
  })
  return outcome
}

// S3a: the addresses of one list are replaced whole, in one batch: the old ones go, the list's row says what was loaded
// and when, the new ones come in chunks (the SQL text holds placeholders only). The other lists are not touched.
// M10: `published` is the day of the source file: the file's own for a read of the list file (`made`, the time its maker
// made it: the read is then a good read, checked_at and made_at), the one the command found in an official XML for a
// manual load, or null for a list made by hand. A manual load leaves checked_at and made_at as they were. Either load clears what was held.
// `read`: for the list file, the SHA-256 of the list as the sync read it (null: none was loaded). A list that changed since
// (a manual load landed meanwhile) stops the whole batch: entries = 0 breaks its CHECK, so nothing is written and the
// newer load stays; the sync throws, and the next one compares again (CodeRabbit, PR #1646).
async function replaceList(db: D1Database, list: string, sha256: string, addresses: string[], now: number, published: string | null = null, made: number | null = null, read?: string | null) {
  const chunks = Array.from({ length: Math.ceil(addresses.length / CHUNK) }, (_, i) => addresses.slice(i * CHUNK, (i + 1) * CHUNK))
  await db.batch([
    ...(read === undefined ? [] : [db.prepare('UPDATE sanctions_lists SET entries = 0 WHERE list = ? AND sha256 IS NOT ?').bind(list, read)]),
    db.prepare('DELETE FROM sanctioned_addresses WHERE list = ?').bind(list),
    db.prepare(`INSERT INTO sanctions_lists (list, sha256, entries, loaded_at, published, checked_at, made_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (list) DO UPDATE SET sha256 = excluded.sha256, entries = excluded.entries, loaded_at = excluded.loaded_at, published = excluded.published,
                  checked_at = COALESCE(excluded.checked_at, checked_at), made_at = COALESCE(excluded.made_at, made_at), held = NULL, held_adds = NULL`).bind(list, sha256, addresses.length, now, published, made === null ? null : now, made),
    ...chunks.map((part) => db.prepare(`INSERT INTO sanctioned_addresses (list, address) VALUES ${part.map((_, n) => `(?1, ?${n + 2})`).join(', ')}`).bind(list, ...part)),
  ])
  return freezeHits(db, now, made === null ? 'operator' : 'system')
}
// S3b: every organisation that holds a live wallet (LISTED in data.ts) on ANY loaded list is a hit, and an active one
// is frozen in a commit of its own, with a row in its own log that names the wallet. Everything that decides the freeze
// is read again inside that commit. After every load, and at every daily run or "sync" that loads nothing, whatever
// the list file gave: a freeze that failed is tried again there (G1). The actor is the operator for a manual load, the system for the list file (G7).
// ponytail: every listed wallet of every organisation, at each call. Page the hits when they pass some hundreds.
// Free plan (ARCHITECTURE.md): at most FREEZES commits per call. A commit is 4 D1 queries, 8 after a collision, and an
// invocation has 50. An active hit after them is marked `later`: the next call freezes it (the next daily run, or the
// operator's "sync" now), as it tries again a freeze that failed.
export const FREEZES = 5
async function freezeHits(db: D1Database, now: number, actorKind: 'operator' | 'system') {
  const hits = (await db.prepare(`SELECT o.id, o.name, o.state, w.address FROM wallets w JOIN organisations o ON o.id = w.org_id WHERE ${LISTED} ORDER BY o.id, w.rowid`).bind(now).all<{ id: string; name: string; state: string; address: string }>()).results
  const frozen = new Map<string, boolean>()
  for (const hit of hits) {
    // One commit per organisation, whatever the number of its listed wallets, and none for one that is not active: it
    // cannot be frozen, and a commit costs 3 to 4 queries of the few an invocation has.
    if (hit.state !== 'active' || frozen.has(hit.id)) continue
    if (frozen.size === FREEZES) break
    frozen.set(hit.id, await commit(db, hit.id, async () => {
      const wallet = await listedWallet(db, hit.id, now)
      const active = await db.prepare(`SELECT 1 FROM organisations WHERE id = ? AND state = 'active'`).bind(hit.id).first()
      return wallet && active ? [{ at: now, actorKind, actorId: null, sessionId: null, action: 'screening.wallet', subjectId: wallet.id }, freezing(db, hit.id, now)] : null
    }))
  }
  return hits.map((hit) => ({ ...hit, frozen: frozen.get(hit.id) ?? false, ...(hit.state === 'active' && !frozen.has(hit.id) && { later: true }) }))
}

// ---- milestone 5b: the sealed declaration (key-custody.md sections 3 and 4) ----
// The signed declaration is encrypted in the member's browser, in the age v1 format, to the operator's recipient (a
// hybrid ML-KEM-768 + X25519 key, "age1pq1..."). The Worker holds no key and never sees the clear file.
// The sealing key of an environment is named by its fingerprint, the SHA-256 of the recipient string. It is a constant
// per environment, never read from a request. local: the test recipient that "pnpm seed" made (SEAL_RECIPIENT in
// .dev.vars; public, its identity file stays on the developer's machine). production: the recipient of the
// security-key ceremony (SEAL_RECIPIENT in wrangler.jsonc env.production, equal to PRODUCTION in onboarding.tsx; empty
// until the ceremony). Any other environment, or no recipient of the form: null, and an upload answers "not configured".
export const SEAL = { maxBytes: 10 * 1024 * 1024 + 8192, generation: 'g1' } // 10 MB of clear file, and room for the age header and the tag of each 64 KiB
// Why the operator takes a sealed item: a code of this list goes into the client's audit log with every download.
export const DOWNLOAD_REASONS: Record<string, string> = {
  kyb_review: 'the review of the organisation', periodic_review: 'a periodic review', authority_request: 'a request of an authority',
  client_request: 'a request of the organisation', incident: 'an incident',
}
const RECIPIENT = /^age1pq1[a-z0-9]{1500,2500}$/
export const sealKey = async (env: { ENVIRONMENT: string; SEAL_RECIPIENT?: string }) =>
  (env.ENVIRONMENT === 'local' || env.ENVIRONMENT === 'production') && RECIPIENT.test(env.SEAL_RECIPIENT ?? '') ? sha256Hex(env.SEAL_RECIPIENT!) : null
/**
 * What the Worker can check without a key (key-custody.md section 3): an age v1 file whose header is exactly the one
 * of a single hybrid stanza (1,627 bytes: the share of 1,120 bytes, the wrapped file key of 32, the header MAC), and a
 * payload that holds at least a nonce and one tag. A classic X25519 stanza, a second stanza, a stanza of another
 * length and anything that is not age are refused. The stanza does not say whose key it is, and what follows the
 * header is opaque: a sender who writes a correct header in front of a clear file is not found out here.
 */
const HEADER = /^age-encryption\.org\/v1\n-> mlkem768x25519 [A-Za-z0-9+/]{1494}\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n/ // 1,627 characters exactly, so no end anchor
export const sealedShape = (bytes: Uint8Array) => bytes.length >= 1627 + 32 && HEADER.test(String.fromCharCode(...bytes.subarray(0, 1627)))

// The ciphertext of each sealed item, in D1 (sealed_chunks, migration 0024), never R2: past its free tier R2 bills, and
// D1 on the Free plan only refuses (owner, 2026-11-17). D1 carries bytes as an Array of numbers both ways (Array.from on
// bind, millions of values for 10 MB, CPU the Free plan does not have; CodeRabbit, 2026-11-17), so a piece travels as hex
// text, encoded and decoded natively, and SQLite stores it as a BLOB: unhex(?) in, hex(data) out (both checked on the
// production D1). D1 keeps 2,000,000 bytes per string, and hex doubles a piece: under 1,000,000 bytes each (Codex P1,
// 2026-11-17; the local SQLite has no such cap, a test measures it).
export const PIECE = 990_000
declare global { // ES2026, in workerd; TypeScript 5.9 has no type for them yet
  interface Uint8ArrayConstructor { fromHex(hex: string): Uint8Array }
  interface Uint8Array { toHex(): string }
}
export const sealedStore = (db: D1Database) => ({
  async put(id: string, bytes: Uint8Array) {
    for (let n = 0; n * PIECE < bytes.length; n++)
      await db.prepare('INSERT INTO sealed_chunks (item_id, n, data) VALUES (?, ?, unhex(?))').bind(id, n, bytes.subarray(n * PIECE, (n + 1) * PIECE).toHex()).run()
  },
  async get(id: string) {
    const pieces = await db.prepare('SELECT hex(data) FROM sealed_chunks WHERE item_id = ? ORDER BY n').bind(id).raw<[string]>()
    return pieces.length ? new Blob(pieces.map(([piece]) => Uint8Array.fromHex(piece))) : null
  },
  delete: (id: string) => db.prepare('DELETE FROM sealed_chunks WHERE item_id = ?').bind(id).run(),
})

interface Sealed { id: string; kind: string; size: number; sha256: string; key: string; generation: string; at: number }
const SEALED = `id, kind, size, sha256, key_fingerprint AS key, key_generation AS generation, created_at AS at FROM sealed_items`
/** The sealed items of one organisation: what the server knows of each, never a byte of it. */
// ponytail: every download row of the organisation, read at each view. Page it when an organisation passes some hundred downloads.
const downloadsOf = async (db: D1Database, orgId: string) =>
  (await db.prepare(`SELECT at, subject_id AS item, detail AS reason FROM audit_log WHERE org_id = ? AND action = 'sealed.download' ORDER BY seq`).bind(orgId).all<{ at: number; item: string; reason: string }>())
    .results.map((row) => ({ ...row, reason: DOWNLOAD_REASONS[row.reason] ?? row.reason }))
const sealedOf = async (db: D1Database, orgId: string) => (await db.prepare(`SELECT ${SEALED} WHERE org_id = ? ORDER BY created_at, id`).bind(orgId).all<Sealed>()).results

// The row of an upload, in one commit with its audit row, which carries the hash. Read inside the plan: the uploader is
// still an active Owner with this session, and the organisation is still unverified (once it is active the declaration
// it was approved with stays). The new declaration takes the place of the old one; commit() then sees that what was
// submitted has changed (REVIEWED names the item) and the organisation is no longer under review.
async function storeSealed(db: D1Database, actor: Actor, item: { id: string; size: number; sha256: string; key: string }, now: number) {
  let outcome = 'failed'
  let old: string | null = null
  await commit(db, actor.orgId, async () => {
    const who = await ownerNow(db, actor)
    outcome = !who ? 'forbidden' : who.state !== 'unverified' ? 'not_unverified' : 'ok'
    if (outcome !== 'ok') return null
    old = (await db.prepare(`SELECT id FROM sealed_items WHERE org_id = ? AND kind = 'declaration'`).bind(actor.orgId).first<{ id: string }>())?.id ?? null
    return [{ at: now, actorKind: 'seat', actorId: actor.seatId, sessionId: actor.sessionId, action: 'declaration.upload', subjectId: item.id, detail: item.sha256, country: actor.country, asn: actor.asn }, [
      db.prepare(`DELETE FROM sealed_items WHERE org_id = ? AND kind = 'declaration'`).bind(actor.orgId),
      db.prepare(`INSERT INTO sealed_items (id, org_id, kind, key_generation, key_fingerprint, size, sha256, uploaded_by_seat_id, created_at) VALUES (?, ?, 'declaration', ?, ?, ?, ?, ?, ?)`)
        .bind(item.id, actor.orgId, SEAL.generation, item.key, item.size, item.sha256, actor.seatId, now),
    ]]
  })
  return { outcome, old: old as string | null }
}

// ---- the application (public, console host) ----

// The route's context, as much as these handlers read (index.ts builds it).
interface Ctx {
  env: { DB: D1Database; ENVIRONMENT: string; CHALLENGE_KEY: string; SEAL_RECIPIENT?: string; SANCTIONS_URL?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; TELEGRAM_URL?: string }
  now: number; config: Config; body: Record<string, unknown>; params: Record<string, string | undefined>; ctx?: ExecutionContext
}
interface Member extends Ctx { actor: Actor }

// Letters with their combining marks (\p{M}: Thai, Hindi, a decomposed accent) and the typographic apostrophe (l’Église):
// what a company register prints (Codex, PR #1653). No control or format character (\p{C}: escapes, bidi overrides), as
// the operator's terminal prints these, and no < or >.
const LEGAL = /^[\p{L}\p{M}\p{N} .,'’&()/-]{2,120}$/u
const NAME = /^[\p{L}\p{M}\p{N} .'’-]{1,60}$/u
const POSITION = /^[\p{L}\p{M}\p{N} .,'’&()/-]{2,60}$/u
const POSTAL = /^(?=.*[\p{L}\p{N}])[^\p{C}<>]{5,200}$/u
const MAX_PEOPLE = 4 // besides the applicant: 5 people in all
// What the company does (owner, 2026-11-17), and the part of the console it gets: partners follow their partner fees in
// Overview, institutions their orders and statement; every organisation trades on the desk (owner, 2026-11-19). The browser shows the names; the kind is set here, never sent by the page.
export const BUSINESS: Record<string, 'partner' | 'institution'> = {
  wallet: 'partner', exchange: 'partner', app: 'partner', payments: 'partner', protocol: 'partner',
  fund: 'institution', vc: 'institution', bank: 'institution', broker: 'institution', family_office: 'institution', treasury: 'institution',
}
/** An LEI (ISO 17442): 18 letters or digits and 2 check digits, ISO 7064 mod 97-10 over the letters as 10 to 35. */
export function leiValid(lei: string) {
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) return false
  let rest = 0
  for (const char of lei) for (const digit of String(parseInt(char, 36))) rest = (rest * 10 + Number(digit)) % 97
  return rest === 1
}
/** How Ophis reaches a person: a position, a phone in international form (+ and 7 to 15 digits), a Telegram username or none. */
function contactOf(x: Record<string, unknown>): Contact | null {
  const text = (key: string) => (typeof x[key] === 'string' ? (x[key] as string).trim() : '')
  const position = text('position'), phone = text('phone').replace(/[\s().-]/g, ''), telegram = text('telegram').replace(/^@/, '')
  if (!POSITION.test(position) || !/^\+[1-9][0-9]{6,14}$/.test(phone) || (telegram && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegram))) return null
  return { position, phone, telegram: telegram ? `@${telegram}` : null }
}
/**
 * The form, checked. The contact address must be at the company's domain or a subdomain of it, which Ophis checks
 * with the company in its review: no list of mail providers is needed. `people`: 0 to 4
 * more people, each a name, a work email by the same rule, the role Owner or Admin, and a contact (contactOf); no address
 * twice, none the applicant's. The LEI is optional; the registered address is required (owner, 2026-11-17).
 */
function applicant(body: Record<string, unknown>): Applicant | string {
  const field = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '')
  const a = {
    legalName: field('legalName'), country: field('country').toUpperCase(), registration: field('registration'), lei: field('lei').toUpperCase() || null,
    address: field('address').replace(/\s+/g, ' '), businessType: field('businessType'), kind: BUSINESS[field('businessType')] ?? '', domain: field('domain').toLowerCase(), email: field('email').toLowerCase(), name: field('name'),
  }
  const contact = contactOf(body)
  const given = body.people === undefined ? [] : Array.isArray(body.people) && body.people.length <= MAX_PEOPLE ? (body.people as unknown[]) : null
  const people = given?.map((p) => {
    const x = (p ?? {}) as Record<string, unknown>
    return { name: typeof x.name === 'string' ? x.name.trim() : '', email: emailAt(x.email, a.domain), role: x.role, contact: contactOf(x) }
  })
  return !LEGAL.test(a.legalName) ? 'legal_name_invalid'
    : !/^[A-Z]{2}$/.test(a.country) ? 'country_invalid'
    : !/^[A-Za-z0-9 ./-]{2,40}$/.test(a.registration) ? 'registration_invalid'
    : a.lei !== null && !leiValid(a.lei) ? 'lei_invalid'
    : !POSTAL.test(a.address) ? 'address_invalid'
    : !Object.hasOwn(BUSINESS, a.businessType) ? 'kind_invalid'
    : !DOMAIN.test(a.domain) ? 'domain_invalid'
    : !emailAt(a.email, a.domain) ? 'email_not_at_domain'
    : !NAME.test(a.name) ? 'name_invalid'
    : !contact ? 'contact_invalid'
    : !people || people.some((p) => !NAME.test(p.name) || (p.role !== 'owner' && p.role !== 'admin')) ? 'people_invalid'
    : people.some((p, i) => !p.email || p.email === a.email || people.findIndex((q) => q.email === p.email) < i) ? 'person_email_invalid'
    : people.some((p) => !p.contact) ? 'person_contact_invalid'
    : ({ ...a, ...contact, people: people.map(({ contact: c, ...p }) => ({ ...p, ...c })) } as Applicant)
}

const APPLY = 'apply-intent' // the labels of this file's texts under the challenge key
// G1: applications are by invitation (owner, 2026-11-17): a code of 12 characters, three groups of four in Crockford
// base32 (32 symbols, no I, L, O or U: 60 random bits), made by the operator's command, valid 48 hours, good for one
// organisation. The server keeps the SHA-256 of its 12 characters (invites, 0027); the organisation it makes stores the
// same hash, unique (0007). Read the way a person types it: any case, spaces and dashes ignored, O read as 0, I and L as
// 1. Checked before anything else on every call of /apply; "Create the organisation" then has the 7 days of the intent,
// which carries the hash. ponytail: no count of wrong guesses: 60 bits are out of reach at the Free plan's 100,000 requests a day.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const inviteText = (raw: unknown) => {
  const text = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1') : ''
  return text.length === 12 && [...text].every((char) => CROCKFORD.includes(char)) ? text : null
}
async function invited(c: Ctx) {
  const code = inviteText(c.body.invite)
  if (!code) return 'invite_invalid'
  const hash = await sha256Hex(code)
  const row = await c.env.DB.prepare('SELECT expires_at AS expiresAt, EXISTS (SELECT 1 FROM organisations WHERE invite_hash = ?1) AS used FROM invites WHERE code_hash = ?1')
    .bind(hash).first<{ expiresAt: number; used: number }>()
  return !row || row.expiresAt <= c.now ? 'invite_invalid' : row.used ? 'invite_used' : { hash }
}
const ACTIVATE = 'activate-intent'

// POST /api/apply, two calls, no session. First: the form in, the options for a device-bound passkey out, for a seat
// id made here. Second: the form and that passkey's registration in, a MAC-signed intent out.
// Nothing is written, and the one read is whether the application code was used.
// ponytail: Turnstile comes before this route in production; it is not built. Each intent costs a code and a passkey registration.
export async function apply(c: Ctx) {
  const code = await invited(c)
  if (typeof code === 'string') return fail(403, code)
  const a = applicant(c.body)
  if (typeof a === 'string') return fail(400, a)
  const { seat } = c.body
  if (typeof seat !== 'string' || !ID.test(seat)) {
    const made = randomId()
    return json(200, { seat: made, options: creationOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'apply', `${made}.${a.domain}`, c.now), { id: made, name: a.name }, false) })
  }
  let credential
  try {
    credential = await verifyRegistration(c.config, c.body.response, (challenge) => challengeIsOurs(c.env.CHALLENGE_KEY, 'apply', `${seat}.${a.domain}`, challenge, c.now))
  } catch {
    return fail(400, 'passkey_rejected')
  }
  // Any passkey (owner, 2026-11-17): the organisation it makes allows passkeys that sync; its Owners can require hardware keys later.
  const hash = `0x${hex(await credentialHash(credential.id, credential.publicKey))}`
  const issuedAt = Math.floor(c.now / 1000)
  const intent: ApplyIntent = {
    ...a, inviteHash: code.hash, seat, credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports, deviceBound: credential.deviceBound },
    credentialHash: hash, issuedAt, expiresAt: issuedAt + WEEK_S, site: c.config.rpId,
  }
  return json(200, { intent: await seal(c.env.CHALLENGE_KEY, APPLY, intent), expiresAt: intent.expiresAt * 1000 })
}

// POST /api/apply/check, "Create the organisation". The MAC first, then the expiry, then the one commit. The invitation
// still has to be unused, and one organisation per domain holds (the database's rules). The route keeps its name: a
// page loaded before 2026-11-18 calls it, with a `skipDns` field that is now ignored. No outside service is asked.
export async function applyCheck(c: Ctx) {
  const intent = (await unseal(c.env.CHALLENGE_KEY, APPLY, typeof c.body.intent === 'string' ? c.body.intent : '')) as ApplyIntent | null
  if (!intent) return fail(400, 'intent_invalid')
  if (intent.expiresAt * 1000 <= c.now) return fail(410, 'intent_expired')
  const outcome = await createOrganisation(c.env.DB, intent, c.now)
  return outcome === 'ok' ? json(200, { state: 'unverified' }) : refuse(outcome)
}

// ---- the Onboarding page (a session of the organisation) ----

const walletView = (w: WalletRow) => {
  const seen = w.snapshot ? (JSON.parse(w.snapshot) as SafeState) : null
  return { chainId: w.chainId, chain: CHAIN_NAME[w.chainId] ?? `Chain ${w.chainId}`, address: checksum(w.address), kind: w.kind, label: w.label, inForce: w.inForce === 1, recoveryEligible: w.recoveryEligible === 1, ...(seen && { threshold: seen.threshold, owners: seen.owners.length }) }
}

// GET /api/onboarding (Owner, Compliance officer): the steps with their state, the review status and the KYB record.
export async function onboarding(c: Member) {
  const orgId = c.actor.orgId
  const { company, record } = await reviewOf(c.env.DB, orgId)
  const first = await firstOf(c.env.DB, orgId)
  const wallet = await walletOf(c.env.DB, orgId, c.now)
  const sealed = await sealedOf(c.env.DB, orgId)
  const status = company.state !== 'unverified' ? 'verified' : company.reviewAt !== null ? 'under_review' : record?.decision === 'pending' ? 'more_information' : 'not_submitted'
  return json(200, {
    company: { legalName: company.legalName, kind: company.kind, businessType: company.businessType, country: company.country, registration: company.registration, lei: company.lei, address: company.address, domain: company.domain },
    first: first && { credentialHash: first.hash, active: first.active === 1, name: first.name, position: first.position },
    people: await peopleOf(c.env.DB, orgId), // the people the application named besides the first Owner: Ophis approves them with the organisation
    // Milestone 5b: the sealing key of this environment (its fingerprint; null: none configured), and the sealed declaration as the server knows it.
    seal: { key: await sealKey(c.env), generation: SEAL.generation },
    sealed: sealed.find((item) => item.kind === 'declaration') ?? null,
    // Every time the operator took a sealed item of this organisation, with the reason in words: from its own audit log.
    downloads: await downloadsOf(c.env.DB, orgId),
    wallet: wallet && walletView(wallet),
    // What "Submit for review" would answer now: null when everything is there.
    missing: company.state === 'unverified' ? await missing(c.env.DB, orgId) : null,
    review: { status, since: company.reviewAt, reason: status === 'more_information' ? record!.reason : null },
    record: record && { ...record, reason: record.decision === 'approved' ? null : record.reason },
    chains: Object.keys(c.config.chains).map((id) => ({ id: Number(id), name: CHAIN_NAME[Number(id)] ?? `Chain ${id}` })),
  })
}

// M10: the OFAC list, read from the file at SANCTIONS_URL (the address rule of the indexer's: https, or plain http to
// this machine in the local environment). ONE GET, no redirect followed, 5 seconds, 2 MB, and every field checked.
// Outcomes: not_connected (the setting is empty: the feature is off); unavailable (any failure at all, an address that is
// not taken included: the lists do not change, and the last good read grows old); same (the same SHA-256 AND the same addresses:
// only the time of the check moves); held (the file is not loaded and the reason is stored; a first load is never held);
// loaded (through replaceList: atomic, and it freezes as a manual load does). Every other outcome, not_connected and
// unavailable too, then freezes what a load left for later and a freeze that failed (freezeHits): a load with more
// than FREEZES active hits is finished by the daily runs, also when no list file is set. The operator's manual load
// stays the fallback and the override: it clears what is held and is
// itself never held. The file never rolls it back: a file whose day is not after the loaded one's and that differs is
// held as "older" (only a strictly newer file replaces a list; a manual load of an official XML carries its day); a
// list made by hand, with no day, holds every other file as "manual" until the operator loads a dated file by hand; a
// file that lacks more than a fifth of the loaded addresses is "shrunk", one that adds more than a fifth of them "grown".
type Hits = Awaited<ReturnType<typeof freezeHits>>
export type Synced = ({ outcome: 'not_connected' | 'unavailable' | 'same' } | { outcome: 'held'; reason: 'older' | 'shrunk' | 'grown' | 'manual' }) & { hits?: Hits }
  | { outcome: 'loaded'; entries: number; published: string; hits: Hits }
export async function sync(env: { DB: D1Database; ENVIRONMENT: string; SANCTIONS_URL?: string }, now: number): Promise<Synced> {
  const read = await readList(env, now)
  if (read.outcome === 'loaded') return read // replaceList has frozen
  const hits = await freezeHits(env.DB, now, 'system')
  return hits.length ? { ...read, hits } : read
}
async function readList(env: { DB: D1Database; ENVIRONMENT: string; SANCTIONS_URL?: string }, now: number): Promise<Synced> {
  if (!env.SANCTIONS_URL) return { outcome: 'not_connected' }
  const url = indexerBase({ ENVIRONMENT: env.ENVIRONMENT, INDEXER_URL: env.SANCTIONS_URL })
  if (!url) return { outcome: 'unavailable' } // set, and not taken (http in production, a query string): a warning, never silence
  let file: { sha256: string; published: string; made: number; addresses: string[] }
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FEED.timeoutMs) })
    const f = JSON.parse((response.status === 200 && (await readCapped(response.body, FEED.maxBytes))) || '') as Record<string, unknown> | null
    // list is "ofac"; the SHA-256 of the source; published a real day, not after tomorrow; made a real time, not more than a day ahead; count equals the number of addresses, which are as a load takes them.
    if (!f || f.list !== 'ofac' || typeof f.sha256 !== 'string' || !SHA256.test(f.sha256) || !publishedOk(f.published, now) || !madeOk(f.made, now) || !listable(f.addresses) || f.count !== f.addresses.length) throw Object.assign(new Error('shape'), { name: 'shape' })
    file = { sha256: f.sha256, published: f.published, made: Date.parse(f.made), addresses: f.addresses }
  } catch (error) {
    console.error('sanctions list unavailable', error instanceof Error ? error.name : 'unknown') // one word: no address of the file
    return { outcome: 'unavailable' }
  }
  const loaded = await env.DB.prepare(`SELECT sha256, entries, published FROM sanctions_lists WHERE list = 'ofac'`).first<{ sha256: string; entries: number; published: string | null }>()
  // The file against the loaded addresses (G2), not only the counts. ponytail: the whole list at each read.
  const have = new Set((await env.DB.prepare(`SELECT address FROM sanctioned_addresses WHERE list = 'ofac'`).all<{ address: string }>()).results.map((r) => r.address))
  const added = file.addresses.filter((address) => !have.has(address)).length
  const missing = have.size - (file.addresses.length - added)
  const same = loaded?.sha256 === file.sha256 && !added && !missing
  const reason = !loaded || same ? null
    : loaded.published === null ? 'manual' : file.published <= loaded.published ? 'older'
    : missing > 0 ? 'shrunk' : added > loaded.entries * FEED.hold ? 'grown' : null
  if (!loaded || (!same && !reason)) return { outcome: 'loaded', entries: file.addresses.length, published: file.published, hits: await replaceList(env.DB, 'ofac', file.sha256, file.addresses, now, file.published, file.made, loaded?.sha256 ?? null) }
  // A hold that saw new addresses (or an unknown count) stays until a load: a later file that adds nothing, or the
  // loaded list again, does not lower it, so names once seen missing keep the desk stopped until a person loads a list.
  // Merged in the statement, against the row as it is when written (SQLite reads the old row in every SET): two syncs
  // at once cannot undo each other. Only over the row that was read (G6): a manual load that landed since keeps its own.
  await env.DB.prepare(`UPDATE sanctions_lists SET checked_at = ?1, made_at = ?2,
      held = CASE WHEN held IS NOT NULL AND COALESCE(held_adds, 1) > 0 THEN COALESCE(?3, held) ELSE ?3 END,
      held_adds = CASE WHEN held IS NOT NULL AND COALESCE(held_adds, 1) > 0 THEN (CASE WHEN held_adds IS NULL THEN NULL ELSE MAX(held_adds, COALESCE(?4, 0)) END) ELSE ?4 END
    WHERE list = 'ofac' AND sha256 = ?5`).bind(now, file.made, reason, reason ? added : null, loaded.sha256).run()
  return reason ? { outcome: 'held', reason } : { outcome: 'same' }
}
/**
 * For the operator's list: each loaded list, and whether the OFAC list is stale. With SANCTIONS_URL set (even to an
 * address that is not taken): when the last good read of the file, or the making of the file read then, is missing or
 * 3 days old or more; a feed that stops, or a maker that stops while the file is still served, must be seen. With no
 * file outside the local environment (production loads the list by hand, monthly): when no list was loaded, or the
 * last load is 35 days old or more. Locally, with no file, the feature is off.
 */
async function listsOf(env: { DB: D1Database; ENVIRONMENT: string; SANCTIONS_URL?: string }, now: number) {
  const rows = (await env.DB.prepare('SELECT list, entries, published, loaded_at AS loadedAt, checked_at AS checkedAt, made_at AS madeAt, held, held_adds AS heldAdds FROM sanctions_lists ORDER BY list')
    .all<{ list: string; entries: number; published: string | null; loadedAt: number | null; checkedAt: number | null; madeAt: number | null; held: string | null; heldAdds: number | null }>()).results
  const fed = Boolean(env.SANCTIONS_URL), due = fed || env.ENVIRONMENT !== 'local'
  if (due && !rows.some((r) => r.list === 'ofac')) rows.push({ list: 'ofac', entries: 0, published: null, loadedAt: null, checkedAt: null, madeAt: null, held: null, heldAdds: null }) // set, and never read
  const within = (time: number | null, ms: number) => (time ?? 0) > now - ms
  return rows.map((r) => ({ ...r, stale: due && r.list === 'ofac' && !(fed ? within(r.checkedAt, FEED.staleMs) && within(r.madeAt, FEED.staleMs) : within(r.loadedAt, FEED.manualMs)) }))
}
// The desk's stop: an empty or old list would pass every address, so no order is sent while the operator sees the OFAC
// line stale, or held with a file that has addresses the loaded list lacks (or not known how many): those names would
// pass. A held file that only removes addresses leaves the screen stricter and does not stop it. The operator lifts the
// stop by loading the list by hand after the last good read, less than 3 days ago (the fallback).
export const ofacStale = async (env: { DB: D1Database; ENVIRONMENT: string; SANCTIONS_URL?: string }, now: number) => (await listsOf(env, now))
  .some((r) => r.list === 'ofac' && (r.stale || (r.held !== null && (r.heldAdds ?? 1) > 0)) && !(r.loadedAt !== null && r.loadedAt > (r.checkedAt ?? 0) && r.loadedAt > now - FEED.staleMs))

// GET /api/screening (the roles that read the audit log; active organisations only): the Compliance page's section.
// The organisation's own screening is answered only when its newest record says "clear": no other outcome is ever sent
// to a browser. With it: the loaded address lists, which are no client's, and each linked wallet of this organisation.
export async function screening(c: Member) {
  const db = c.env.DB
  const [record, lists, wallets] = await db.batch([
    db.prepare(`SELECT screening_outcome AS outcome, screening_lists AS lists, screening_list_version_hash AS hash, screened_at AS screenedAt, recheck_at AS nextReview ${NEWEST}`).bind(c.actor.orgId),
    db.prepare('SELECT list, entries, loaded_at AS loadedAt, sha256 FROM sanctions_lists ORDER BY list'),
    db.prepare(`SELECT label, address, chain_id AS chainId, EXISTS (SELECT 1 FROM sanctioned_addresses s WHERE s.address = w.address) AS listed FROM wallets w WHERE w.org_id = ? AND w.state = 'linked' ORDER BY w.rowid`).bind(c.actor.orgId),
  ])
  const r = record.results[0] as { outcome: string | null; lists: string; hash: string; screenedAt: number; nextReview: number | null } | undefined
  return json(200, {
    organisation: r?.outcome === 'clear' ? { lists: Object.keys(JSON.parse(r.lists)).map((code) => LISTS[code]), version: r.hash.slice(0, 16), screenedAt: r.screenedAt, nextReview: r.nextReview } : null,
    lists: (lists.results as { list: string; entries: number; loadedAt: number; sha256: string }[]).map((l) => ({ name: LISTS[l.list], entries: l.entries, loadedAt: l.loadedAt, version: l.sha256.slice(0, 16) })),
    wallets: (wallets.results as { label: string; address: string; chainId: number; listed: number }[]).map((w) => ({ label: w.label, address: checksum(w.address), chain: CHAIN_NAME[w.chainId] ?? `Chain ${w.chainId}`, listed: w.listed === 1 })),
  })
}

/** What the Owner asked the recovery wallet to sign, held nowhere. The fields of a recovery intent, with the wallet named. */
export interface ActivateIntent {
  kind: 'activate'; org: string; seat: string; chainId: number; wallet: string; label: string; custodian: boolean
  credentialHash: string; nonce: string; issuedAt: number; expiresAt: number; site: string
}
// POST /api/onboarding/wallet (Owner, fresh, strong key): chain and address of the recovery wallet in, a signing
// link out. Writes nothing. The passkey is the first Owner's, read from the rows, never from the caller.
export async function activationIntent(c: Member) {
  const { chainId, custodian } = c.body
  const address = parseAddress(c.body.address)
  const label = typeof c.body.label === 'string' ? c.body.label.trim() : ''
  if (typeof chainId !== 'number' || !Object.hasOwn(c.config.chains, chainId)) return fail(400, 'chain_invalid')
  if (!address) return fail(400, 'address_invalid')
  if (!LABEL.test(label)) return fail(400, 'label_invalid')
  if (typeof custodian !== 'boolean') return fail(400, 'invalid')
  const first = await firstOf(c.env.DB, c.actor.orgId)
  if (first?.state !== 'unverified') return fail(409, 'not_unverified')
  if (!first.active) return fail(409, 'first_passkey_gone')
  const issuedAt = Math.floor(c.now / 1000)
  const intent: ActivateIntent = {
    kind: 'activate', org: c.actor.orgId, seat: c.actor.seatId, chainId, wallet: checksum(address), label, custodian, credentialHash: first.hash,
    nonce: `0x${randomId()}${randomId()}`, issuedAt, expiresAt: issuedAt + WEEK_S, site: c.config.rpId,
  }
  const sealed = await seal(c.env.CHALLENGE_KEY, ACTIVATE, intent)
  return json(200, { intent: sealed, link: `${c.config.signOrigin}/sign/#${sealed}`, expiresAt: intent.expiresAt * 1000 })
}

/** The fields of an activation intent, if the MAC is ours. */
export const activateIntent = (key: string, sealed: string) => unseal(key, ACTIVATE, sealed) as Promise<ActivateIntent | null>
// The proof route's third kind (index.ts has checked the MAC, the expiry, the counter and the signature's form): the
// wallet's signature over the Proof struct with the fourth action, built from the intent and this environment's site,
// checked by the one verifier. The kind as for a link: a Safe only when it is a genuine one.
export async function activationProof(c: Ctx, intent: ActivateIntent, signature: `0x${string}`) {
  const endpoints = c.config.chains[intent.chainId]
  if (!endpoints) return fail(400, 'signature_invalid')
  const typed = typedProof({
    kind: 'activate', chainId: intent.chainId, site: c.config.rpId, organisationId: intent.org, wallet: intent.wallet,
    credentialHash: intent.credentialHash, nonce: intent.nonce, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt,
  })
  const proved = await verify(endpoints, typed, intent.wallet, signature)
  if (!proved) return fail(403, 'signature_rejected')
  const safe = proved.by === 'contract' ? await safeState(endpoints, intent.chainId, intent.wallet) : null
  const outcome = await storeProof(c.env.DB, {
    orgId: intent.org, seatId: intent.seat, chainId: intent.chainId, address: intent.wallet.toLowerCase(), label: intent.label, credentialHash: intent.credentialHash,
    kind: safe ? 'safe' : intent.custodian && proved.by === 'key' ? 'custodian' : 'single_key', snapshot: safe && JSON.stringify(safe),
    nonce: intent.nonce, digest: proved.digest, signature, by: proved.by,
  }, c.now)
  return outcome === 'stored' ? json(200, { state: 'stored' }) : refuse(outcome)
}

// POST /api/onboarding/declaration (Owner, fresh, strong key). The body is the sealed file and nothing else; the
// router has capped its size. The header x-seal-key names the key the browser sealed to: a console built for another
// key is told so, and a row never names a key that this console's page did not use. The SHA-256 is computed here, of
// the bytes that arrived. The pieces go into sealed_chunks first, under the item's random id, then the row: when a
// piece or the row is refused or fails, the pieces are taken out again; when it replaces an older item, that one's go.
// ponytail: a Worker that dies between the two, or D1's daily quota that runs out between two pieces (the DELETE then fails
// too), leaves pieces that no row names: never served, only space. Sweep sealed_chunks against sealed_items if that ever matters.
export async function sealDeclaration(c: Member & { request: Request; bytes: Uint8Array }) {
  const key = await sealKey(c.env)
  if (!key) return fail(503, 'not_configured')
  if (c.request.headers.get('x-seal-key') !== key) return fail(409, 'key_changed')
  if (!sealedShape(c.bytes)) return fail(400, 'not_sealed')
  const item = { id: randomId(), size: c.bytes.length, sha256: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', c.bytes))), key }
  const store = sealedStore(c.env.DB)
  let stored: Awaited<ReturnType<typeof storeSealed>> = { outcome: 'failed', old: null }
  try {
    await store.put(item.id, c.bytes)
    stored = await storeSealed(c.env.DB, c.actor, item, c.now)
  } finally {
    const gone = stored.outcome === 'ok' ? stored.old : item.id
    if (gone) await store.delete(gone)
  }
  return stored.outcome === 'ok' ? json(200, { ...item, at: c.now, generation: SEAL.generation }) : refuse(stored.outcome)
}

// POST /api/onboarding/submit (Owner, fresh, strong key).
export async function submit(c: Member) {
  const outcome = await submitForReview(c.env.DB, c.actor, c.now)
  if (outcome !== 'ok') return refuse(outcome)
  const told = tellOperator(c.env, c.actor.orgId)
  if (c.ctx) c.ctx.waitUntil(told)
  else await told
  return json(200, { state: 'under_review' })
}

// The operator hears of each application submitted for review (owner, 2026-11-17): one Telegram message to the chat
// TELEGRAM_CHAT_ID from the bot TELEGRAM_BOT_TOKEN, both Worker secrets; without them nothing is sent. Plain text from
// the server's own values. After the commit and out of the answer's way (waitUntil): a failure changes nothing for the
// client, and nothing about it is logged (the address holds the bot's token).
async function tellOperator(env: Ctx['env'], orgId: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return
  try {
    const o = await env.DB.prepare('SELECT name, business_type AS type, kind, country, email_domain AS domain FROM organisations WHERE id = ?').bind(orgId)
      .first<{ name: string; type: string | null; kind: string; country: string | null; domain: string | null }>()
    if (!o) return
    const text = `New application to review on pro.ophis.fi: ${o.name} (${o.type ?? o.kind}${o.country ? `, ${o.country}` : ''}), ${o.domain ?? 'no domain'}.\nOrganisation ${orgId}.\nReview it: ${OPERATOR[env.ENVIRONMENT] ?? OPERATOR.production}/`
    await fetch(`${standIn(env, env.TELEGRAM_URL) ?? 'https://api.telegram.org'}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Telegram is down or slow: the application stands, and the operator's list shows it.
  }
}

// ---- the operator's API (its own hostname) ----
// These routes answer on the hostnames of OPERATOR only: locally with the token alone, in production behind Cloudflare
// Access too (accessEmail), and 404 in any other environment. The review page (2026-11-19) holds no token: Access's email
// must be OPERATOR_EMAIL (operate). The command holds OPERATOR_TOKEN (locally in .dev.vars, made by
// the seed script; in production a Worker secret, and on the operator's Mac a Keychain item). The operator can: list what is under
// review, record a KYB decision, freeze and unfreeze, make an application code, and (milestone 5b) list the sealed items
// of an organisation and take one, still sealed, for a stated reason, and (sanctions screening) record a screening and
// load the addresses of a public list. Nothing else: no route here takes a passkey, a member or a client's wallet address.

interface OperatorEnv { DB: D1Database; ENVIRONMENT: string; CHALLENGE_KEY: string; OPERATOR_TOKEN?: string; OPERATOR_EMAIL?: string; SANCTIONS_URL?: string; ACCESS_TEAM?: string; ACCESS_AUD?: string }

// What the operator compares before a decision: the domain, the first Owner's passkey hash, the people the application
// named besides the first Owner (an approval approves them too), the recovery wallet with its kind and its colour (read
// on both endpoints now, as if it were in force), whether A7 holds, and the sealed declaration: its id, size, date and
// SHA-256. And, in a field of its own, the reviews that are due (S4).
// Free plan (ARCHITECTURE.md): the oldest UNDER_REVIEW only, in full; `more` counts the others. Each costs 7 D1 queries
// and, for a Safe, 14 reads of the chain: 50 subrequests per invocation hold 3 (in production one more reads the Access
// keys: 43). A decision takes one off the list.
// ponytail: no way past the oldest 3. Decide "more" on one that waits, or add an offset, if that ever blocks.
export const UNDER_REVIEW = 3
async function list(c: Ctx) {
  const organisations = []
  const waiting = await underReview(c.env.DB)
  for (const o of waiting.slice(0, UNDER_REVIEW)) {
    const first = (await firstOf(c.env.DB, o.id))!
    const wallet = await walletOf(c.env.DB, o.id, c.now)
    const endpoints = wallet?.kind === 'safe' ? c.config.chains[wallet.chainId] : undefined
    const live = endpoints ? await safeState(endpoints, wallet!.chainId, wallet!.address) : null
    organisations.push({
      id: o.id, legalName: o.legalName, kind: o.kind, businessType: o.businessType, country: o.country, registration: o.registration, lei: o.lei, address: o.address, domain: o.domain, submittedAt: o.reviewAt, submission: await submissionOf(o.print, wallet),
      applicant: { name: first.name, email: first.email, position: first.position, phone: first.phone, telegram: first.telegram },
      credentialHash: first.hash, people: await peopleOf(c.env.DB, o.id), missing: await missing(c.env.DB, o.id),
      // Milestone 5b: that the sealed declaration exists, and what the server knows of it. "items" and "get" are the way to the file.
      declaration: (await sealedOf(c.env.DB, o.id)).find((item) => item.kind === 'declaration') ?? null,
      refused: await refusedOf(c.env.DB, o.id), // sanctions screening: a wallet this application named was on a loaded list
      wallet: wallet && { ...walletView(wallet), colour: colour({ kind: wallet.kind, snapshot: wallet.snapshot, inForce: true }, live) },
    })
  }
  return json(200, { organisations, more: waiting.length - organisations.length, reviews: await reviewsDue(c.env.DB, c.now), lists: await listsOf(c.env, c.now), all: await everyOrganisation(c.env.DB, c.now) })
}

const MAX_REVIEW_MS = 5 * 365 * 24 * 60 * 60 * 1000 // owner's call: a next review lies at most 5 years ahead; a date further off would hide the organisation from "Reviews due" for good
/**
 * The next review as the command gives it, YYYY-MM-DD: a real day (the parser moves 2027-02-31 to 3 March: refused),
 * after now and at most 5 years ahead. Unix ms at 00:00 UTC, or null when it is not one.
 */
function reviewDay(value: unknown, now: number) {
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN
  return ms > now && ms <= now + MAX_REVIEW_MS && new Date(ms).toISOString().slice(0, 10) === value ? ms : null
}
/**
 * S2a: a screening as the command sends it, checked: `outcome` (clear, review or hit) and `lists`, an object from the
 * code of each list searched to the SHA-256 of the list file (64 hex); the EU list is in every screening. Null: not one.
 */
async function screeningOf(value: unknown): Promise<Screening | null> {
  const { outcome, lists } = (value ?? {}) as { outcome?: unknown; lists?: unknown }
  const given = (lists ?? {}) as Record<string, unknown>
  const codes = Object.keys(given).sort() // of an array or a text: its indexes, which are no list code
  if (!OUTCOMES.includes(outcome as string) || !codes.includes('eu') || !codes.every((code) => Object.hasOwn(LISTS, code) && typeof given[code] === 'string' && SHA256.test(given[code]))) return null
  const text = JSON.stringify(Object.fromEntries(codes.map((code) => [code, given[code]])))
  return { outcome: outcome as string, lists: text, hash: await sha256Hex(text) }
}

// A decision: approve, refuse, or more information. Codes from fixed lists, a reference, a hash and a date: no free text
// reaches the audit log. An approval names the submission it is for, as the list showed it. For an approval the wallet's proof is checked again first, a contract wallet's on both
// endpoints, and a Safe must be readable: what is read then is the snapshot of the recovery wallet in force.
async function decide(c: Ctx) {
  const id = c.params.id ?? ''
  const { decision, reason, tier, source, evidenceRef, evidenceSha256, nextReview, submission, screening } = c.body
  const approve = decision === 'approve'
  const day = approve ? reviewDay(nextReview, c.now) : null
  if (!ID.test(id) || !Object.hasOwn(KYB_ACTION, String(decision)) || !TIERS.includes(tier as string) || !SOURCES.includes(source as never)
    || (approve ? reason !== undefined || day === null || typeof submission !== 'string' || !/^[0-9a-f]{16}$/.test(submission) : !REASONS.includes(reason as never) || nextReview !== undefined)
    || (evidenceRef === undefined ? approve : typeof evidenceRef !== 'string' || !/^[\w ./:#-]{1,120}$/.test(evidenceRef))
    || (evidenceSha256 === undefined ? approve : typeof evidenceSha256 !== 'string' || !SHA256.test(evidenceSha256))) return fail(400, 'invalid')
  // S2b: an approval carries a screening whose outcome is "clear"; for the other decisions one is optional, and stored when given.
  const screened = screening === undefined ? null : await screeningOf(screening)
  if (screening !== undefined && !screened) return fail(400, 'invalid')
  if (approve && !screened) return fail(400, 'screening_required')
  if (approve && screened!.outcome !== 'clear') return fail(409, 'screening_not_clear')
  let checked: { id: string; snapshot: string | null } | null = null
  const wallet = approve ? await walletOf(c.env.DB, id, c.now) : null
  if (wallet) {
    const endpoints = c.config.chains[wallet.chainId]
    const proved = endpoints && (await verifyDigest(endpoints, wallet.chainId, wallet.digest as `0x${string}`, wallet.address, wallet.signature as `0x${string}`))
    const live = proved && wallet.kind === 'safe' ? await safeState(endpoints, wallet.chainId, wallet.address) : null
    if (!proved || (wallet.kind === 'safe' && !live)) return fail(409, 'wallet_unreadable')
    checked = { id: wallet.id, snapshot: live ? JSON.stringify(live) : wallet.snapshot }
  }
  const outcome = await decideKyb(c.env.DB, id, {
    decision: decision as Decision, submission: approve ? (submission as string) : null, reason: approve ? null : (reason as string), tier: tier as string, source: source as string,
    evidenceRef: (evidenceRef as string | undefined) ?? null, evidenceSha256: (evidenceSha256 as string | undefined) ?? null, nextReview: day, screening: screened,
  }, checked, c.now)
  return outcome === 'ok' ? json(200, { state: { approve: 'active', refuse: 'archived', more: 'unverified' }[decision as Decision] }) : refuse(outcome)
}
// S2c. POST .../organisations/:id/screening with {outcome, lists, nextReview, tier?, source?}: the result of a search the
// operator made offline, for an organisation that is active or frozen. The next review date is checked as a decision's is.
async function screen(c: Ctx) {
  const id = c.params.id ?? ''
  const { nextReview, tier, source } = c.body
  const screened = await screeningOf(c.body)
  const day = reviewDay(nextReview, c.now)
  if (!ID.test(id) || !screened || day === null || (tier !== undefined && !TIERS.includes(tier as string)) || (source !== undefined && !SOURCES.includes(source as never))) return fail(400, 'invalid')
  const outcome = await recordScreening(c.env.DB, id, screened, day, { tier: tier as string | undefined, source: source as string | undefined }, c.now)
  return outcome === 'active' || outcome === 'frozen' ? json(200, { state: outcome }) : refuse(outcome)
}
// S3a. POST /api/operator/sanctions with {list, sha256, addresses}: the addresses the command took from one list file, and
// the SHA-256 of that file. 1 to 1,000 of them, each 0x and 40 hex characters in lower case, none twice. An empty load
// is refused, so that a file the command could not read never empties the list.
async function loadList(c: Ctx) {
  // M10: `published`, when the command found the publish day of an official XML in the file: kept, so that the daily read of the list file never rolls this load back.
  const { list, sha256, addresses, published } = c.body
  if (typeof list !== 'string' || !Object.hasOwn(LISTS, list) || typeof sha256 !== 'string' || !SHA256.test(sha256) || !listable(addresses) || (published !== undefined && !publishedOk(published, c.now))) return fail(400, 'invalid')
  return json(200, { list, entries: addresses.length, hits: await replaceList(c.env.DB, list, sha256, addresses, c.now, published ?? null) })
}
// M10. POST /api/operator/sanctions/sync: the operator asks for the read of the list file now, as the daily run does it.
const syncNow = async (c: Ctx) => json(200, await sync(c.env, c.now))
// Milestone 5b. GET .../organisations/:id/items: the sealed items of one organisation, as the server knows them.
async function items(c: Ctx) {
  return ID.test(c.params.id ?? '') ? json(200, { items: await sealedOf(c.env.DB, c.params.id!) }) : fail(404, 'not_found')
}
// POST /api/operator/items/:id/download with {reason}: the one way a sealed file leaves, as ciphertext, to the operator.
// First a row in the client's own audit log: the operator, the item, and the reason, a code of the fixed list. When
// that row cannot be written nothing leaves. The item is read again inside the commit: one that is replaced at the
// same instant is gone, and no row says it was taken. No route returns clear text: the Worker holds no key. The
// decryption is offline (README; key-custody.md section 4) and is not logged.
async function download(c: Ctx) {
  const id = c.params.id ?? ''
  const { reason } = c.body
  if (!ID.test(id) || typeof reason !== 'string' || !Object.hasOwn(DOWNLOAD_REASONS, reason)) return fail(400, 'invalid')
  const item = await c.env.DB.prepare('SELECT org_id AS orgId, sha256, key_fingerprint AS key FROM sealed_items WHERE id = ?').bind(id).first<{ orgId: string; sha256: string; key: string }>()
  if (!item) return fail(404, 'not_found')
  const logged = await commit(c.env.DB, item.orgId, async () => {
    if (!(await c.env.DB.prepare('SELECT 1 FROM sealed_items WHERE org_id = ? AND id = ?').bind(item.orgId, id).first())) return null
    return [{ at: c.now, actorKind: 'operator', actorId: null, sessionId: null, action: 'sealed.download', subjectId: id, detail: reason }, []]
  })
  const object = logged ? await sealedStore(c.env.DB).get(id) : null
  if (!object) return fail(404, 'not_found')
  return new Response(object, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': item.sha256, 'x-seal-key': item.key } })
}
// G1: a new invitation code: 12 random characters of CROCKFORD (each a byte's low 5 bits: 256 is a multiple of 32, so no
// bias), its hash and expiry written. ponytail: issued codes are not listed anywhere; the operator makes them (the command, or the review page).
async function invite(c: Ctx) {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => CROCKFORD[byte & 31]).join('')
  const expiresAt = c.now + INVITE_MS
  await c.env.DB.prepare('INSERT INTO invites (code_hash, expires_at, created_at) VALUES (?, ?, ?)').bind(await sha256Hex(code), expiresAt, c.now).run()
  return json(200, { code: code.match(/.{4}/g)!.join('-'), expiresAt })
}
const freeze = (frozen: boolean) => async (c: Ctx) => {
  const outcome = ID.test(c.params.id ?? '') ? await setFrozen(c.env.DB, c.params.id!, frozen, c.now) : 'not_found'
  return outcome === 'ok' ? json(200, { state: frozen ? 'frozen' : 'active' }) : refuse(outcome)
}

// page: the routes the review page calls, the only ones a request with no token reaches (Trail of Bits, PR #1670: the
// sign-in cloudflared keeps in a file must not stand in for the Keychain's token on the other routes).
export const operatorRoutes: { method: 'GET' | 'POST'; path: string; handler: (c: Ctx) => Promise<Response>; page?: true }[] = [
  { method: 'GET', path: '/api/operator/organisations', handler: list, page: true },
  { method: 'POST', path: '/api/operator/organisations/:id/decision', handler: decide, page: true },
  { method: 'POST', path: '/api/operator/organisations/:id/freeze', handler: freeze(true) },
  { method: 'POST', path: '/api/operator/organisations/:id/unfreeze', handler: freeze(false) },
  { method: 'POST', path: '/api/operator/invites', handler: invite, page: true },
  { method: 'GET', path: '/api/operator/organisations/:id/items', handler: items },
  { method: 'POST', path: '/api/operator/items/:id/download', handler: download },
  { method: 'POST', path: '/api/operator/organisations/:id/screening', handler: screen },
  { method: 'POST', path: '/api/operator/sanctions', handler: loadList },
  { method: 'POST', path: '/api/operator/sanctions/sync', handler: syncNow },
]

// Outside local, Cloudflare Access (Zero Trust Free) stands in front of the operator's hostname, and the Worker checks
// Access's signed proof itself, the header Cf-Access-Jwt-Assertion (Cloudflare's "Validate JWTs"; ctx.access is not given
// to a Worker with static files): RS256 by a key of the team's list, the issuer, the application's AUD tag, the expiry.
// So a request that did not pass the Access policy (the application deleted, a header made up) gets 403, even with the
// token. ACCESS_TEAM: the team's domain, <team>.cloudflareaccess.com; ACCESS_AUD: the application's AUD tag (wrangler.jsonc).
// Either missing: every request is refused. The keys are read at each request: 5 s, 64 KB, no redirect followed, one
// subrequest. It answers the email the proof names (empty if it names none), or null: refused. The token's callers (the
// command) go on whoever Access let in; the review page, which holds no token, must be the operator's email (operate).
export async function accessEmail(request: Request, env: { ACCESS_TEAM?: string; ACCESS_AUD?: string }, now: number): Promise<string | null> {
  const team = env.ACCESS_TEAM ?? '', jwt = request.headers.get('cf-access-jwt-assertion') ?? ''
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !env.ACCESS_AUD || !jwt) return null
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const [header, claims] = parts.slice(0, 2).map((part) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))))
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null
    const response = await fetch(`https://${team}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const text = response.ok ? await readCapped(response.body, 64 * 1024) : null
    const key = text === null ? undefined : (JSON.parse(text).keys as (JsonWebKey & { kid?: unknown })[]).find((k) => k.kid === header.kid)
    if (!key) return null
    const rsa = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    const signed = await crypto.subtle.verify(rsa, await crypto.subtle.importKey('jwk', key, rsa, false, ['verify']), fromBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const valid = signed && claims.iss === `https://${team}` && audiences.includes(env.ACCESS_AUD) && typeof claims.exp === 'number' && claims.exp * 1000 > now && !(typeof claims.nbf === 'number' && claims.nbf * 1000 > now)
    return valid ? (typeof claims.email === 'string' ? claims.email : '') : null
  } catch {
    return null // malformed, a key that does not import, the keys unreadable: refused
  }
}

// Access first outside local; then the same request checks as on the other two hosts, then who: the token (the command),
// or, for a request with none (the review page, owner 2026-11-19), the email Access signed must be OPERATOR_EMAIL, a
// secret (no address in this public code). Locally no Access stands in front: OPERATOR_EMAIL stands for the person.
// Digests are compared, so the time it takes says nothing about the token.
async function operate(request: Request, env: OperatorEnv, clock: () => number, config: Config): Promise<Response> {
  if (!Object.hasOwn(OPERATOR, env.ENVIRONMENT)) return fail(404, 'not_found')
  const email = env.ENVIRONMENT === 'local' ? env.OPERATOR_EMAIL ?? '' : await accessEmail(request, env, clock())
  if (email === null) return fail(403, 'access_required')
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return fail(403, 'cross_site')
  const { pathname } = new URL(request.url)
  const patterns = operatorRoutes.map((route) => new URLPattern({ pathname: route.path })) // made here, not at load: the scripts import this file on Node 22, which has no URLPattern
  const index = operatorRoutes.findIndex((route, i) => route.method === request.method && patterns[i].test({ pathname }))
  if (index < 0) return fail(404, 'not_found')
  if (request.method === 'POST' && request.headers.get('origin') !== OPERATOR[env.ENVIRONMENT]) return fail(403, 'bad_origin')
  const sent = request.headers.get('authorization')
  // ASCII letters only are folded (Trail of Bits, PR #1670: toLowerCase turns the Kelvin sign into k).
  const fold = (text: string) => text.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const token = env.OPERATOR_TOKEN, operator = fold(env.OPERATOR_EMAIL ?? '')
  if (sent === null) {
    if (!operatorRoutes[index].page || !operator.includes('@') || fold(email) !== operator) return fail(401, 'operator_identity')
  } else if (typeof token !== 'string' || token.length < 32 || !sent.startsWith('Bearer ') || (await sha256Hex(sent.slice(7))) !== (await sha256Hex(token))) return fail(401, 'operator_token')
  let body: Record<string, unknown> = {}
  if (request.method === 'POST') {
    if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return fail(415, 'json_only')
    const text = await readCapped(request.body, MAX_BODY)
    if (text === null) return fail(413, 'too_large')
    try {
      body = JSON.parse(text)
    } catch {
      return fail(400, 'bad_json')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_json')
  }
  return operatorRoutes[index].handler({ env, now: clock(), config, body, params: patterns[index].exec({ pathname })?.pathname.groups ?? {} })
}
/** Every request that arrives on the operator's hostname. `headers`: the API headers of index.ts, set on every answer. */
export async function operator(request: Request, env: OperatorEnv, clock: () => number, config: Config, headers: Record<string, string>) {
  const answer = await operate(request, env, clock, config)
  const response = new Response(answer.body, answer)
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}
