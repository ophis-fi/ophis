// Milestone 5a: how an organisation comes to exist and becomes active (recovery.md section 3).
//   /apply            a company applies: its details, the first Owner's passkey, and a DNS record that proves the domain
//   Onboarding        the Owner adds a second passkey, names the recovery wallet (which signs) or enrols a second Owner, submits
//   operator's API    on its own hostname: the KYB decision, freeze and unfreeze; each a row in the client's own audit log
// This file holds its own handlers and, in its first half, its own rows: every statement is prepared with bound
// parameters, and every change goes through commit() of the data module, with what decides it read inside the plan.
import { checksum, colour, parseAddress, readCapped, safeState, verify, verifyDigest, type SafeState } from './chain.ts'
import { commit, randomId, sha256Hex, type Actor, type WalletKind } from './data.ts'
import { challengeIsOurs, creationOptions, credentialHash, fromBase64Url, newChallenge, phraseFor, seal, unseal, verifyRegistration, type Config } from './passkeys.ts'
import { CHAIN_NAME, typedProof } from './typed.ts'

// Constants per environment, like those of passkeys.ts, and never read from a request.
// RESOLVERS: two DNS-over-HTTPS resolvers of different operators, JSON form; both must give the record. The local
// environment asks two stubs that the dev and end-to-end scripts start (scripts/dns-stub.mjs): no stub lives here.
// PUBLIC_RESOLVERS: Cloudflare and Google, for the production entry; `pnpm test:dns` asks them with this file's parser.
export const PUBLIC_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'] as const
export const RESOLVERS: Record<string, readonly [string, string]> = { local: ['http://127.0.0.1:8790/dns-query', 'http://127.0.0.1:8791/resolve'] }
// The operator's API has a hostname of its own, as the signing page has.
export const OPERATOR: Record<string, string> = { local: 'http://operator.localhost:8787' }

export const DNS = { timeoutMs: 5000, maxBytes: 16 * 1024 }
const WEEK_S = 7 * 24 * 60 * 60
const INVITE_S = 14 * 24 * 60 * 60 // an application code lives 14 days
const MAX_BODY = 64 * 1024
const ID = /^[0-9a-f]{32}$/
const LABEL = /^[\p{L}\p{N} ._()-]{1,40}$/u
export const REASONS = ['entity_not_found', 'details_differ', 'authority_unclear', 'wallet_differs', 'declaration_needed', 'not_eligible'] as const
export const SOURCES = ['registry', 'gleif', 'supervisor_register', 'declaration'] as const
const TIERS = ['standard', 'enhanced']

// The words of this file's audit actions, for the audit page and the export (spread into EVENTS of index.ts).
export const ONBOARDING_EVENTS: Record<string, string> = {
  'organisation.apply': 'Organisation created by an application: its DNS record proved the company domain, first Owner passkey active',
  'activation.proof': 'Recovery wallet signed the activation and confirmed the first Owner passkey',
  'review.submit': 'Organisation submitted for review',
  'kyb.approve': 'Ophis operator: verification approved, organisation active',
  'kyb.refuse': 'Ophis operator: verification refused, organisation closed',
  'kyb.more': 'Ophis operator: more information asked, the review was sent back',
  'organisation.freeze': 'Ophis operator: organisation frozen',
  'organisation.unfreeze': 'Ophis operator: organisation unfrozen',
}
const KYB_ACTION = { approve: 'kyb.approve', refuse: 'kyb.refuse', more: 'kyb.more' } as const
type Decision = keyof typeof KYB_ACTION

const json = (status: number, body: unknown) => Response.json(body, { status })
const fail = (status: number, error: string) => json(status, { error })
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, too_many: 429 }
const refuse = (error: string) => fail(STATUS[error] ?? 409, error)
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const bytesOf = (hex0x: string) => Uint8Array.from(hex0x.slice(2).match(/../g) ?? [], (pair) => parseInt(pair, 16))

// ---- rows ----

interface Passkey { id: string; publicKey: string; counter: number; transports: string[] }
interface Applicant { legalName: string; country: string; registration: string; kind: 'partner' | 'institution'; domain: string; email: string; name: string }
/** What /apply asked for, signed by the server and held nowhere: nothing is written before the DNS record is seen. Times are Unix seconds. */
interface ApplyIntent extends Applicant { inviteHash: string; seat: string; credential: Passkey; credentialHash: string; issuedAt: number; expiresAt: number; site: string }

// The one write of an application, after its DNS proof: the organisation (unverified), its first Owner seat, that
// seat's passkey (active) and the first row of its audit log, which names the seat, the passkey and the passkey's
// hash for good. One organisation per domain among those that are not archived is the database's rule (the unique
// index of 0006), and so are "an intent makes one organisation, once" (the primary keys of its seat and passkey) and
// "an application code makes one organisation, once" (the unique index of 0007 on its hash).
async function createOrganisation(db: D1Database, a: ApplyIntent, value: string, now: number) {
  const orgId = randomId()
  let outcome = 'not_stored'
  try {
    await commit(db, orgId, () => {
      outcome = 'ok'
      return [{ at: now, actorKind: 'seat', actorId: a.seat, sessionId: null, action: 'organisation.apply', subjectId: a.credential.id, detail: a.credentialHash }, [
        db.prepare(`INSERT INTO organisations (id, kind, name, state, email_domain, domain_challenge, domain_verified_at, country, registration_number, invite_hash, created_at)
                    VALUES (?, ?, ?, 'unverified', ?, ?, ?, ?, ?, ?, ?)`).bind(orgId, a.kind, a.legalName, a.domain, value, now, a.country, a.registration, a.inviteHash, now),
        db.prepare(`INSERT INTO seats (id, org_id, display_name, email, role, state, created_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?)`).bind(a.seat, orgId, a.name, a.email, now),
        db.prepare(`INSERT INTO credentials (id, org_id, seat_id, public_key, counter, device_bound, transports, label, state, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'First key', 'active', ?)`)
          .bind(a.credential.id, orgId, a.seat, a.credential.publicKey, a.credential.counter, JSON.stringify(a.credential.transports), now),
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

/** The first Owner of an organisation that applied: the seat, the passkey and its hash from the first audit row, the organisation's state, and whether that passkey is still active on that Owner seat. */
interface First { seatId: string; credentialId: string; hash: string; state: string; reviewAt: number | null; active: number }
const firstOf = (db: D1Database, orgId: string) =>
  db.prepare(`SELECT a.actor_id AS seatId, a.subject_id AS credentialId, a.detail AS hash, o.state, o.review_at AS reviewAt,
                     (SELECT count(*) FROM credentials k JOIN seats s ON s.org_id = k.org_id AND s.id = k.seat_id AND s.role = 'owner' AND s.state = 'active'
                      WHERE k.org_id = a.org_id AND k.id = a.subject_id AND k.seat_id = a.actor_id AND k.state = 'active') AS active
              FROM audit_log a JOIN organisations o ON o.id = a.org_id WHERE a.org_id = ? AND a.seq = 1 AND a.action = 'organisation.apply'`).bind(orgId).first<First>()

/**
 * A7: what a review needs, from the rows as they are now. Two device-bound passkeys on the first Owner's seat, and
 * either the activation proof (a wallet stored as pending, while the passkey it confirmed is still active) or a second
 * Owner with two device-bound passkeys. Null: it holds. Read when the Owner submits and again when the operator approves.
 */
async function missing(db: D1Database, orgId: string): Promise<null | 'not_found' | 'second_key' | 'proof_or_owner'> {
  const first = await firstOf(db, orgId)
  if (!first) return 'not_found'
  const owner = `s.org_id = ?1 AND s.role = 'owner' AND s.state = 'active' AND (SELECT count(*) FROM credentials k WHERE k.org_id = s.org_id AND k.seat_id = s.id AND k.state = 'active' AND k.device_bound = 1) >= 2`
  const seen = (await db.prepare(`SELECT (SELECT count(*) FROM seats s WHERE ${owner} AND s.id = ?2) AS own, (SELECT count(*) FROM seats s WHERE ${owner} AND s.id <> ?2) AS others,
                                         (SELECT count(*) FROM wallets w WHERE w.org_id = ?1 AND w.state = 'pending') AS proof`).bind(orgId, first.seatId).first<{ own: number; others: number; proof: number }>())!
  return !seen.own ? 'second_key' : (seen.proof && first.active) || seen.others ? null : 'proof_or_owner'
}

interface Proved { orgId: string; chainId: number; address: string; kind: WalletKind; label: string; snapshot: string | null; credentialHash: string; nonce: string; digest: string; signature: string }
// A valid activation proof arrived. One commit: the organisation is still unverified, the passkey the wallet confirmed
// is still the first Owner's and active, the proof was never accepted (proof_nonce is unique and rows stay). The wallet
// is stored as pending with its proof and replaces an earlier one. No approval request: the operator's decision is the
// second check. A new proof is a new thing to review, so an organisation under review is no longer submitted.
async function storeProof(db: D1Database, w: Proved, now: number) {
  const id = randomId()
  let outcome = 'not_unverified'
  await commit(db, w.orgId, async () => {
    const first = await firstOf(db, w.orgId)
    outcome = first?.state !== 'unverified' ? 'not_unverified' : !first.active || first.hash !== w.credentialHash ? 'first_passkey_gone'
      : (await db.prepare('SELECT 1 FROM wallets WHERE proof_nonce = ?').bind(w.nonce).first()) ? 'proof_used' : 'stored'
    if (outcome !== 'stored') return null
    return [{ at: now, actorKind: 'anchor', actorId: id, sessionId: null, action: 'activation.proof', subjectId: id, detail: w.kind }, [
      db.prepare(`UPDATE wallets SET state = 'unlinked' WHERE org_id = ? AND state = 'pending'`).bind(w.orgId),
      db.prepare(`INSERT INTO wallets (id, org_id, chain_id, address, kind, label, state, proof_nonce, proof_digest, proof_signature, proof_checked_at, linked_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .bind(id, w.orgId, w.chainId, w.address, w.kind, w.label, w.nonce, w.digest, w.signature, now, now, w.snapshot),
      db.prepare('UPDATE organisations SET review_at = NULL WHERE id = ?').bind(w.orgId),
    ]]
  })
  return outcome
}

// "Submit for review": the Owner, the session and the organisation's state are read inside the commit, and so is A7.
async function submitForReview(db: D1Database, actor: Actor, now: number) {
  let outcome = 'forbidden'
  await commit(db, actor.orgId, async () => {
    const who = await db.prepare(`SELECT o.state, o.review_at AS reviewAt FROM seats s JOIN sessions x ON x.org_id = s.org_id AND x.seat_id = s.id AND x.id = ? AND x.revoked_at IS NULL
                                  JOIN organisations o ON o.id = s.org_id WHERE s.org_id = ? AND s.id = ? AND s.state = 'active' AND s.role = 'owner'`)
      .bind(actor.sessionId, actor.orgId, actor.seatId).first<{ state: string; reviewAt: number | null }>()
    outcome = !who ? 'forbidden' : who.state !== 'unverified' ? 'not_unverified' : who.reviewAt !== null ? 'already_submitted' : (await missing(db, actor.orgId)) ?? 'ok'
    if (outcome !== 'ok') return null
    return [{ at: now, actorKind: 'seat', actorId: actor.seatId, sessionId: actor.sessionId, action: 'review.submit', subjectId: actor.orgId, country: actor.country, asn: actor.asn },
      [db.prepare('UPDATE organisations SET review_at = ? WHERE id = ?').bind(now, actor.orgId)]]
  })
  return outcome
}

interface WalletRow { id: string; chainId: number; address: string; kind: WalletKind; label: string; snapshot: string | null; digest: string; signature: string; inForce: number }
// The wallet of the onboarding: the proved one that waits for the review, or, once the organisation is active, its recovery wallet.
const walletOf = (db: D1Database, orgId: string) =>
  db.prepare(`SELECT w.id, w.chain_id AS chainId, w.address, w.kind, w.label, w.snapshot, w.proof_digest AS digest, w.proof_signature AS signature, w.anchor IS NOT NULL AS inForce
              FROM wallets w JOIN organisations o ON o.id = w.org_id WHERE w.org_id = ? AND ((o.state = 'unverified' AND w.state = 'pending') OR (o.state <> 'unverified' AND w.anchor IS NOT NULL))
              ORDER BY w.rowid DESC LIMIT 1`).bind(orgId).first<WalletRow>()

interface Company { id: string; legalName: string; kind: string; state: string; country: string | null; registration: string | null; domain: string | null; domainVerifiedAt: number | null; reviewAt: number | null }
const COMPANY = `id, name AS legalName, kind, state, country, registration_number AS registration, email_domain AS domain, domain_verified_at AS domainVerifiedAt, review_at AS reviewAt FROM organisations`
interface KybRow { legalName: string; registration: string | null; country: string; tier: string; source: string; evidenceSha256: string | null; decision: string; reason: string | null; decidedAt: number | null; nextReview: number | null }
/** The organisation of this session and its newest KYB row: the result, never a document. */
async function reviewOf(db: D1Database, orgId: string) {
  const [company, record] = await db.batch([
    db.prepare(`SELECT ${COMPANY} WHERE id = ?`).bind(orgId),
    db.prepare(`SELECT legal_name AS legalName, registration_number AS registration, country, tier, source, evidence_sha256 AS evidenceSha256, decision, reason, decided_at AS decidedAt, recheck_at AS nextReview
                FROM kyb_records WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(orgId),
  ])
  return { company: company.results[0] as Company, record: (record.results[0] as KybRow | undefined) ?? null }
}
const underReview = async (db: D1Database) =>
  (await db.prepare(`SELECT ${COMPANY} WHERE state = 'unverified' AND review_at IS NOT NULL ORDER BY review_at, id`).all<Company>()).results

interface Kyb { decision: Decision; reason: string | null; tier: string; source: string; evidenceRef: string | null; evidenceSha256: string | null; nextReview: number | null }
// The operator's decision, in one commit with its row in the client's own audit log (actor kind "operator"). Read
// inside the plan: the organisation is unverified and under review, and for an approval A7 still holds. The wallet the
// handler just checked on the chain is still the one that waits: a new proof takes the organisation out of review
// (storeProof), so a decision that follows it is refused here. Approve: the organisation is active and that wallet is
// the recovery wallet in force at once. Refuse: archived. More information: back to the Owner. The KYB row copies the
// organisation's own name, number and country: the operator sets no field of the organisation, no member, no passkey
// and no wallet address.
async function decideKyb(db: D1Database, orgId: string, d: Kyb, checked: { id: string; snapshot: string | null } | null, now: number) {
  const id = randomId()
  let outcome = 'not_found'
  await commit(db, orgId, async () => {
    const o = await db.prepare('SELECT name, country, registration_number AS registration, state, review_at AS reviewAt FROM organisations WHERE id = ?')
      .bind(orgId).first<{ name: string; country: string; registration: string | null; state: string; reviewAt: number | null }>()
    outcome = !o ? 'not_found' : o.state !== 'unverified' || o.reviewAt === null ? 'not_under_review'
      : d.decision !== 'approve' ? 'ok' : (await missing(db, orgId)) ? 'not_ready' : 'ok'
    if (outcome !== 'ok' || !o) return null
    return [{ at: now, actorKind: 'operator', actorId: null, sessionId: null, action: KYB_ACTION[d.decision], subjectId: id, detail: d.decision === 'approve' ? d.evidenceSha256 : d.reason }, [
      db.prepare(`INSERT INTO kyb_records (id, org_id, legal_name, registration_number, country, tier, source, evidence_ref, evidence_sha256, decision, decided_at, recheck_at, reason, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, orgId, o.name, o.registration, o.country, d.tier, d.source, d.evidenceRef, d.evidenceSha256, { approve: 'approved', refuse: 'rejected', more: 'pending' }[d.decision], now, d.nextReview, d.reason, now),
      db.prepare('UPDATE organisations SET state = ?, review_at = NULL WHERE id = ?').bind({ approve: 'active', refuse: 'archived', more: 'unverified' }[d.decision], orgId),
      ...(d.decision === 'approve' && checked ? [db.prepare(`UPDATE wallets SET state = 'linked', linked_at = ?, anchor = 'current', anchor_effective_at = ?, snapshot = ? WHERE org_id = ? AND id = ? AND state = 'pending'`)
        .bind(now, now, checked.snapshot, orgId, checked.id)] : []),
    ]]
  })
  return outcome
}

// Freeze: an active organisation only. An unverified one is never frozen: an unfreeze would make it active with no review.
async function setFrozen(db: D1Database, orgId: string, frozen: boolean, now: number) {
  const [from, to] = frozen ? ['active', 'frozen'] : ['frozen', 'active']
  let outcome = 'not_found'
  await commit(db, orgId, async () => {
    const o = await db.prepare('SELECT state FROM organisations WHERE id = ?').bind(orgId).first<{ state: string }>()
    outcome = !o ? 'not_found' : o.state !== from ? 'wrong_state' : 'ok'
    if (outcome !== 'ok') return null
    return [{ at: now, actorKind: 'operator', actorId: null, sessionId: null, action: frozen ? 'organisation.freeze' : 'organisation.unfreeze', subjectId: orgId },
      [db.prepare('UPDATE organisations SET state = ? WHERE id = ? AND state = ?').bind(to, orgId, from)]]
  })
  return outcome
}

// ---- the application (public, console host) ----

// The route's context, as much as these handlers read (index.ts builds it).
interface Ctx {
  env: { DB: D1Database; ENVIRONMENT: string; CHALLENGE_KEY: string }
  now: number; config: Config; body: Record<string, unknown>; params: Record<string, string | undefined>
}
interface Member extends Ctx { actor: Actor }

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const LEGAL = /^[\p{L}\p{N} .,'&()/-]{2,120}$/u
const NAME = /^[\p{L}\p{N} .'-]{1,60}$/u
/** The form, checked. The contact address must be at the company's domain or a subdomain of it: the DNS proof of that domain is then the proof that this is a company address, and no list of mail providers is needed. */
function applicant(body: Record<string, unknown>): Applicant | string {
  const field = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '')
  const a = { legalName: field('legalName'), country: field('country').toUpperCase(), registration: field('registration'), kind: field('kind'), domain: field('domain').toLowerCase(), email: field('email').toLowerCase(), name: field('name') }
  const host = a.email.slice(a.email.lastIndexOf('@') + 1)
  return !LEGAL.test(a.legalName) ? 'legal_name_invalid'
    : !/^[A-Z]{2}$/.test(a.country) ? 'country_invalid'
    : !/^[A-Za-z0-9 ./-]{2,40}$/.test(a.registration) ? 'registration_invalid'
    : a.kind !== 'partner' && a.kind !== 'institution' ? 'kind_invalid'
    : !DOMAIN.test(a.domain) ? 'domain_invalid'
    : a.email.length > 254 || !/^[^\s@]{1,64}@[^\s@]+$/.test(a.email) || !DOMAIN.test(host) || (host !== a.domain && !host.endsWith(`.${a.domain}`)) ? 'email_not_at_domain'
    : !NAME.test(a.name) ? 'name_invalid'
    : (a as Applicant)
}

const APPLY = 'apply-intent' // the labels of this file's texts under the challenge key
const INVITE = 'apply-invite'
// G1: applications are by invitation. An application code is the server's own text (MAC label "apply-invite": an id
// and an expiry), made by the operator's command, valid 14 days, good for one organisation: its SHA-256 is stored
// unique on the organisation it makes. Checked before anything else on every call of /apply; "unused" is the one
// read of that route. The code never leaves the browser again: the intent carries its hash.
async function invited(c: Ctx) {
  const code = typeof c.body.invite === 'string' ? c.body.invite.trim() : ''
  const fields = (await unseal(c.env.CHALLENGE_KEY, INVITE, code)) as { expiresAt: number } | null
  if (!fields || fields.expiresAt * 1000 <= c.now) return 'invite_invalid'
  const hash = await sha256Hex(code)
  return (await c.env.DB.prepare('SELECT 1 FROM organisations WHERE invite_hash = ?').bind(hash).first()) ? 'invite_used' : { hash }
}
const ACTIVATE = 'activate-intent'
export const dnsName = (domain: string) => `_ophis-verify.${domain}`
/** What the DNS administrator publishes: a MAC over the domain and the hash of this passkey. A record left by another application, or made for another domain, proves nothing. */
export const dnsValue = async (key: string, domain: string, hash: string) => `ophis-verify=${(await seal(key, 'apply-dns', { domain, credentialHash: hash })).split('.')[1].slice(0, 20)}`

// POST /api/apply, two calls, no session. First: the form in, the options for a device-bound passkey out, for a seat
// id made here. Second: the form and that passkey's registration in, a MAC-signed intent and the DNS record out.
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
    return json(200, { seat: made, options: creationOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'apply', `${made}.${a.domain}`, c.now), { id: made, name: a.name }, true) })
  }
  let credential
  try {
    credential = await verifyRegistration(c.config, c.body.response, (challenge) => challengeIsOurs(c.env.CHALLENGE_KEY, 'apply', `${seat}.${a.domain}`, challenge, c.now))
  } catch {
    return fail(400, 'passkey_rejected')
  }
  if (!credential.deviceBound) return fail(400, 'device_bound_required') // the Owner rule
  const hash = `0x${hex(await credentialHash(credential.id, credential.publicKey))}`
  const issuedAt = Math.floor(c.now / 1000)
  const intent: ApplyIntent = {
    ...a, inviteHash: code.hash, seat, credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports },
    credentialHash: hash, issuedAt, expiresAt: issuedAt + WEEK_S, site: c.config.rpId,
  }
  return json(200, {
    intent: await seal(c.env.CHALLENGE_KEY, APPLY, intent), expiresAt: intent.expiresAt * 1000,
    record: { name: dnsName(a.domain), type: 'TXT', value: await dnsValue(c.env.CHALLENGE_KEY, a.domain, hash) },
  })
}

/**
 * The TXT values a resolver's JSON answer holds for exactly this name, or null when the text is not an answer with
 * status 0. Cloudflare quotes each character string ("\"a\" \"b\""), Google does not: both give the same value here.
 * ponytail: a record reached through a CNAME carries the target's name and is not accepted.
 */
export function txtValues(text: string | null, name: string): string[] | null {
  let answer: { Status?: unknown; Answer?: unknown }
  try {
    answer = JSON.parse(text ?? '')
  } catch {
    return null
  }
  if (!answer || typeof answer !== 'object' || answer.Status !== 0 || (answer.Answer !== undefined && !Array.isArray(answer.Answer))) return null
  const plain = (data: string) => (data.startsWith('"') ? [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1].replace(/\\(.)/g, '$1')).join('') : data)
  return ((answer.Answer ?? []) as { name?: unknown; type?: unknown; data?: unknown }[])
    .filter((r) => r?.type === 16 && typeof r.data === 'string' && typeof r.name === 'string' && r.name.toLowerCase().replace(/\.$/, '') === name)
    .map((r) => plain(r.data as string))
}
// One resolver, asked once: 5 seconds, 16 KB. An error, a timeout, an oversized or malformed answer is null.
export async function lookup(resolver: string, name: string) {
  try {
    const response = await fetch(`${resolver}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS.timeoutMs) })
    return response.ok ? txtValues(await readCapped(response.body, DNS.maxBytes), name) : null
  } catch {
    return null
  }
}

// POST /api/apply/check, "Check DNS". The MAC first, before any lookup; the expiry; then both resolvers must return
// the exact value, which is made again here from the intent's domain and passkey. Only then the one commit.
// ponytail: no counter before the proof (nothing is written before it), so an intent can be checked as often as its
// holder likes: two lookups each. Turnstile is the brake, and it is not built.
export async function applyCheck(c: Ctx) {
  const intent = (await unseal(c.env.CHALLENGE_KEY, APPLY, typeof c.body.intent === 'string' ? c.body.intent : '')) as ApplyIntent | null
  if (!intent) return fail(400, 'intent_invalid')
  if (intent.expiresAt * 1000 <= c.now) return fail(410, 'intent_expired')
  const value = await dnsValue(c.env.CHALLENGE_KEY, intent.domain, intent.credentialHash)
  const answers = await Promise.all(RESOLVERS[c.env.ENVIRONMENT].map((resolver) => lookup(resolver, dnsName(intent.domain))))
  // The refusal names the record again: whoever holds the intent may know what to publish (a resumed application reads it here).
  if (!answers.every((values) => values?.includes(value))) return json(409, { error: 'dns_not_proved', record: { name: dnsName(intent.domain), type: 'TXT', value } })
  const outcome = await createOrganisation(c.env.DB, intent, value, c.now)
  return outcome === 'ok' ? json(200, { state: 'unverified' }) : refuse(outcome)
}

// ---- the Onboarding page (a session of the organisation) ----

// The three words of the first Owner's passkey: what the signers of the recovery wallet compare on the signing page,
// and the operator with the Owner. Same recipe as every phrase (purpose "activation"); its nonce is a MAC over the
// organisation and the passkey, so the words are the same on every screen and nothing is stored for them.
async function wordsOf(c: Ctx, orgId: string, first: First) {
  const mac = fromBase64Url((await seal(c.env.CHALLENGE_KEY, 'activation-phrase', { org: orgId, credential: first.credentialId })).split('.')[1])
  return phraseFor({ site: c.config.rpId, orgId, seatId: first.seatId, role: 'owner', purpose: 'activation', credentialHash: bytesOf(first.hash), nonce: hex(mac.subarray(0, 16)) })
}
const walletView = (w: WalletRow) => {
  const seen = w.snapshot ? (JSON.parse(w.snapshot) as SafeState) : null
  return { chainId: w.chainId, chain: CHAIN_NAME[w.chainId] ?? `Chain ${w.chainId}`, address: checksum(w.address), kind: w.kind, label: w.label, inForce: w.inForce === 1, ...(seen && { threshold: seen.threshold, owners: seen.owners.length }) }
}

// GET /api/onboarding (Owner, Compliance officer): the steps with their state, the review status and the KYB record.
export async function onboarding(c: Member) {
  const orgId = c.actor.orgId
  const { company, record } = await reviewOf(c.env.DB, orgId)
  const first = await firstOf(c.env.DB, orgId)
  const wallet = await walletOf(c.env.DB, orgId)
  const status = company.state !== 'unverified' ? 'verified' : company.reviewAt !== null ? 'under_review' : record?.decision === 'pending' ? 'more_information' : 'not_submitted'
  return json(200, {
    company: { legalName: company.legalName, kind: company.kind, country: company.country, registration: company.registration, domain: company.domain, domainVerifiedAt: company.domainVerifiedAt },
    first: first && { phrase: await wordsOf(c, orgId, first), credentialHash: first.hash, active: first.active === 1 },
    wallet: wallet && walletView(wallet),
    // What "Submit for review" would answer now: null when everything is there.
    missing: company.state === 'unverified' ? await missing(c.env.DB, orgId) : null,
    review: { status, since: company.reviewAt, reason: status === 'more_information' ? record!.reason : null },
    record: record && { ...record, reason: record.decision === 'approved' ? null : record.reason },
    chains: Object.keys(c.config.chains).map((id) => ({ id: Number(id), name: CHAIN_NAME[Number(id)] ?? `Chain ${id}` })),
  })
}

/** What the Owner asked the recovery wallet to sign, held nowhere. The fields of a recovery intent, with the wallet named. */
export interface ActivateIntent {
  kind: 'activate'; org: string; chainId: number; wallet: string; label: string; custodian: boolean
  credentialHash: string; phrase: string; nonce: string; issuedAt: number; expiresAt: number; site: string
}
// POST /api/onboarding/wallet (Owner, fresh, two passkeys): chain and address of the recovery wallet in, a signing
// link out. Writes nothing. The passkey and the words are the first Owner's, read from the rows, never from the caller.
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
  const phrase = await wordsOf(c, c.actor.orgId, first)
  const issuedAt = Math.floor(c.now / 1000)
  const intent: ActivateIntent = {
    kind: 'activate', org: c.actor.orgId, chainId, wallet: checksum(address), label, custodian, credentialHash: first.hash, phrase: phrase.join(' '),
    nonce: `0x${randomId()}${randomId()}`, issuedAt, expiresAt: issuedAt + WEEK_S, site: c.config.rpId,
  }
  const sealed = await seal(c.env.CHALLENGE_KEY, ACTIVATE, intent)
  return json(200, { intent: sealed, link: `${c.config.signOrigin}/sign/#${sealed}`, expiresAt: intent.expiresAt * 1000, phrase })
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
    credentialHash: intent.credentialHash, phrase: intent.phrase, nonce: intent.nonce, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt,
  })
  const proved = await verify(endpoints, typed, intent.wallet, signature)
  if (!proved) return fail(403, 'signature_rejected')
  const safe = proved.by === 'contract' ? await safeState(endpoints, intent.chainId, intent.wallet) : null
  const outcome = await storeProof(c.env.DB, {
    orgId: intent.org, chainId: intent.chainId, address: intent.wallet.toLowerCase(), label: intent.label, credentialHash: intent.credentialHash,
    kind: safe ? 'safe' : intent.custodian && proved.by === 'key' ? 'custodian' : 'single_key', snapshot: safe && JSON.stringify(safe),
    nonce: intent.nonce, digest: proved.digest, signature,
  }, c.now)
  return outcome === 'stored' ? json(200, { state: 'stored' }) : refuse(outcome)
}

// POST /api/onboarding/submit (Owner, fresh, two passkeys).
export async function submit(c: Member) {
  const outcome = await submitForReview(c.env.DB, c.actor, c.now)
  return outcome === 'ok' ? json(200, { state: 'under_review' }) : refuse(outcome)
}

// ---- the operator's API (its own hostname) ----
// ponytail: these routes exist in the local environment only and answer 404 anywhere else, until the validation of a
// Cloudflare Access token is added here, before a first deploy (security-design.md, "Insider at the operator").
// Locally the caller holds OPERATOR_TOKEN (.dev.vars, made by the seed script). The operator can: list what is under
// review, record a KYB decision, freeze and unfreeze, and make an application code. Nothing else: no route here takes a passkey, a member or a
// wallet address.

interface OperatorEnv { DB: D1Database; ENVIRONMENT: string; CHALLENGE_KEY: string; OPERATOR_TOKEN?: string }

// What the operator compares before a decision: the domain, the first Owner's words and passkey hash, the recovery
// wallet with its kind and its colour (read on both endpoints now, as if it were in force), and whether A7 holds.
async function list(c: Ctx) {
  const organisations = []
  for (const o of await underReview(c.env.DB)) {
    const first = (await firstOf(c.env.DB, o.id))!
    const wallet = await walletOf(c.env.DB, o.id)
    const endpoints = wallet?.kind === 'safe' ? c.config.chains[wallet.chainId] : undefined
    const live = endpoints ? await safeState(endpoints, wallet!.chainId, wallet!.address) : null
    organisations.push({
      id: o.id, legalName: o.legalName, kind: o.kind, country: o.country, registration: o.registration, domain: o.domain, submittedAt: o.reviewAt,
      phrase: await wordsOf(c, o.id, first), credentialHash: first.hash, missing: await missing(c.env.DB, o.id),
      wallet: wallet && { ...walletView(wallet), colour: colour({ kind: wallet.kind, snapshot: wallet.snapshot, inForce: true }, live) },
    })
  }
  return json(200, { organisations })
}

// A decision: approve, refuse, or more information. Codes from fixed lists, a reference, a hash and a date: no free text
// reaches the audit log. For an approval the wallet's proof is checked again first, a contract wallet's on both
// endpoints, and a Safe must be readable: what is read then is the snapshot of the recovery wallet in force.
async function decide(c: Ctx) {
  const id = c.params.id ?? ''
  const { decision, reason, tier, source, evidenceRef, evidenceSha256, nextReview } = c.body
  const approve = decision === 'approve'
  const day = approve && typeof nextReview === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(nextReview) ? Date.parse(`${nextReview}T00:00:00Z`) : null
  if (!ID.test(id) || !Object.hasOwn(KYB_ACTION, String(decision)) || !TIERS.includes(tier as string) || !SOURCES.includes(source as never)
    || (approve ? reason !== undefined || !(day! > c.now) : !REASONS.includes(reason as never) || nextReview !== undefined)
    || (evidenceRef === undefined ? approve : typeof evidenceRef !== 'string' || !/^[\w ./:#-]{1,120}$/.test(evidenceRef))
    || (evidenceSha256 === undefined ? approve : typeof evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceSha256))) return fail(400, 'invalid')
  let checked: { id: string; snapshot: string | null } | null = null
  const wallet = approve ? await walletOf(c.env.DB, id) : null
  if (wallet) {
    const endpoints = c.config.chains[wallet.chainId]
    const proved = endpoints && (await verifyDigest(endpoints, wallet.chainId, wallet.digest as `0x${string}`, wallet.address, wallet.signature as `0x${string}`))
    const live = proved && wallet.kind === 'safe' ? await safeState(endpoints, wallet.chainId, wallet.address) : null
    if (!proved || (wallet.kind === 'safe' && !live)) return fail(409, 'wallet_unreadable')
    checked = { id: wallet.id, snapshot: live ? JSON.stringify(live) : wallet.snapshot }
  }
  const outcome = await decideKyb(c.env.DB, id, {
    decision: decision as Decision, reason: approve ? null : (reason as string), tier: tier as string, source: source as string,
    evidenceRef: (evidenceRef as string | undefined) ?? null, evidenceSha256: (evidenceSha256 as string | undefined) ?? null, nextReview: day,
  }, checked, c.now)
  return outcome === 'ok' ? json(200, { state: { approve: 'active', refuse: 'archived', more: 'unverified' }[decision as Decision] }) : refuse(outcome)
}
// G1: a new application code. Nothing is written: the code is the server's own text, and it is used up by the
// organisation it makes. ponytail: issued codes are not listed anywhere; whoever holds the operator's token makes them.
async function invite(c: Ctx) {
  const expiresAt = Math.floor(c.now / 1000) + INVITE_S
  return json(200, { code: await seal(c.env.CHALLENGE_KEY, INVITE, { id: randomId(), expiresAt }), expiresAt: expiresAt * 1000 })
}
const freeze = (frozen: boolean) => async (c: Ctx) => {
  const outcome = ID.test(c.params.id ?? '') ? await setFrozen(c.env.DB, c.params.id!, frozen, c.now) : 'not_found'
  return outcome === 'ok' ? json(200, { state: frozen ? 'frozen' : 'active' }) : refuse(outcome)
}

export const operatorRoutes: { method: 'GET' | 'POST'; path: string; handler: (c: Ctx) => Promise<Response> }[] = [
  { method: 'GET', path: '/api/operator/organisations', handler: list },
  { method: 'POST', path: '/api/operator/organisations/:id/decision', handler: decide },
  { method: 'POST', path: '/api/operator/organisations/:id/freeze', handler: freeze(true) },
  { method: 'POST', path: '/api/operator/organisations/:id/unfreeze', handler: freeze(false) },
  { method: 'POST', path: '/api/operator/invites', handler: invite },
]

// The same request checks as on the other two hosts, then the token. Digests are compared, so the time it takes says
// nothing about the token.
async function operate(request: Request, env: OperatorEnv, clock: () => number, config: Config): Promise<Response> {
  if (env.ENVIRONMENT !== 'local') return fail(404, 'not_found')
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return fail(403, 'cross_site')
  const { pathname } = new URL(request.url)
  const patterns = operatorRoutes.map((route) => new URLPattern({ pathname: route.path })) // made here, not at load: the scripts import this file on Node 22, which has no URLPattern
  const index = operatorRoutes.findIndex((route, i) => route.method === request.method && patterns[i].test({ pathname }))
  if (index < 0) return fail(404, 'not_found')
  if (request.method === 'POST' && request.headers.get('origin') !== OPERATOR[env.ENVIRONMENT]) return fail(403, 'bad_origin')
  const sent = request.headers.get('authorization') ?? ''
  const token = env.OPERATOR_TOKEN
  if (typeof token !== 'string' || token.length < 32 || !sent.startsWith('Bearer ') || (await sha256Hex(sent.slice(7))) !== (await sha256Hex(token))) return fail(401, 'operator_token')
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
