// Worker entry: answers /api/* and leaves every other path to the static assets.
import * as data from './data.ts'
import { checksum, colour, parseAddress, readCapped, safeState, verify, verifyDigest, type SafeState } from './chain.ts'
import { challengeIsOurs, configFor, creationOptions, credentialHash, newChallenge, phraseFor, requestOptions, seal, toBase64Url, unseal, userHandle, verifyAssertion, verifyRegistration, type Config, type Purpose } from './passkeys.ts'
import { CHAIN_NAME, typedLink, typedProof, type ProofKind } from './typed.ts'
import { WORDS } from './words.ts'

export interface Env { DB: D1Database; ASSETS: Fetcher; ENVIRONMENT: string; CHALLENGE_KEY: string }

const IDLE_MS = 15 * 60_000
const ABSOLUTE_MS = 12 * 60 * 60_000
const TOUCH_MS = 60_000
const STEP_UP_MS = 5 * 60_000 // a passkey check is fresh for 5 minutes
const MAX_BODY = 64 * 1024
const COOKIE = '__Host-session'
// __Host- needs Secure, Path=/ and no Domain: the cookie belongs to this exact host, and a sibling site cannot set it.
const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`

// Set on every API response. No Access-Control header is ever sent: no origin gets a CORS grant.
const HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=63072000',
}
// The signing page, on its own hostname: its own scripts and styles only, and it may be framed by the Safe interface,
// which is how Safe owners sign. No cross-origin grant but one: the Safe interface reads manifest.json.
const SIGN_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors https://app.safe.global https://*.safe.global",
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000',
}

interface Context {
  request: Request; env: Env; now: number; config: Config
  body: Record<string, unknown>; params: Record<string, string | undefined>
  /** Set on routes marked session: true, and only there. */
  session: data.Session & { token_hash: string }; actor: data.Actor
}
// The role table: one row per route, enforced by api() below and nowhere else.
// roles: 'public' (no session: the handler says what proves the caller), or the roles whose session may call it.
// fresh: a passkey check in the last 5 minutes (step-up). twoKeys: the seat holds two active passkeys, device-bound
// ones for an Owner; until then it can sign in, pass a check and add its second key, and nothing else that is sensitive.
// settled: refused while the seat is in quarantine after a re-enrolment.
// second: the change needs a second person. Such a route has no handler: the router files the request.
// sign: the route lives on the signing host, and only there; every other route lives on the console host only.
// can: the sentence of this row on the page "What each role can do", which is built from this table.
interface Route {
  method: 'GET' | 'POST'; path: string; roles: 'public' | readonly data.Role[]; fresh?: boolean; twoKeys?: boolean; settled?: boolean
  second?: data.Kind; sign?: boolean; can?: string; handler?: (c: Context) => Promise<Response>
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
const fail = (status: number, error: string) => json(status, { error })
const LABEL = /^[\p{L}\p{N} ._()-]{1,40}$/u
const NAME = /^[\p{L}\p{N} .'-]{1,60}$/u

const mustBeDeviceBound = (t: { role: data.Role; synced_keys_allowed: number }) => data.needsHardware(t.role, t.synced_keys_allowed)
// What a refusal of the data module answers. Everything not listed is a conflict with the present state: 409.
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, own_request: 403, quarantine: 403, override: 403, invalid: 400, ticket_limit: 429, seat_limit: 429 }
const refuse = (error: string) => fail(STATUS[error] ?? 409, error)
// The database refuses a second passkey with the same label on one seat (migrations/0002_labels.sql).
const labelTaken = (error: unknown) => /credentials\.label/.test(String((error as Error)?.message))

// A passkey assertion: checked against the stored key, for a challenge of ours made for this purpose and
// binding, with user verification, from the seat the passkey belongs to. Returns the new counter, or null.
async function assertion(c: Context, response: unknown, stored: { id: string; seat_id: string; public_key: string; counter: number }, purpose: Purpose, binding: string, onChallenge?: (challenge: string) => void) {
  try {
    const counter = await verifyAssertion(c.config, response, stored, (challenge) => {
      onChallenge?.(challenge)
      return challengeIsOurs(c.env.CHALLENGE_KEY, purpose, binding, challenge, c.now)
    })
    return (response as { response?: { userHandle?: unknown } }).response?.userHandle === userHandle(stored.seat_id) ? counter : null
  } catch {
    return null
  }
}
const responseId = (c: Context) => {
  const response = c.body.response as { id?: unknown } | undefined
  return response && typeof response === 'object' && typeof response.id === 'string' ? response.id : null
}
/** The same check inside a session: an active passkey of the member's own seat. */
async function ownAssertion(c: Context, purpose: Purpose, binding: string) {
  const id = responseId(c)
  const credential = id ? await data.credentialOfSeat(c.env.DB, c.actor, id) : null
  const counter = credential ? await assertion(c, c.body.response, { ...credential, seat_id: c.actor.seatId }, purpose, binding) : null
  return credential && counter !== null ? { credentialId: credential.id, counter } : null
}
const checkOptions = async (c: Context, purpose: Purpose, binding: string) =>
  requestOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, purpose, binding, c.now), await data.seatCredentialIds(c.env.DB, c.actor, true))

// The ticket token arrives in the body (it travelled in the URL fragment), never in a path or query.
async function ticketOf(c: Context) {
  const token = c.body.ticket
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return data.ticketByToken(c.env.DB, await data.sha256Hex(token), c.now)
}

async function enrolStart(c: Context) {
  const ticket = await ticketOf(c)
  if (!ticket) return fail(404, 'ticket_invalid')
  const challenge = await newChallenge(c.env.CHALLENGE_KEY, 'enrol', ticket.id, c.now)
  const deviceBound = mustBeDeviceBound(ticket)
  return json(200, {
    organisation: ticket.org_name, member: ticket.display_name, role: ticket.role, deviceBound, first: ticket.kind === 'first_owner',
    options: creationOptions(c.config, challenge, { id: ticket.seat_id, name: ticket.display_name }, deviceBound),
  })
}

async function enrolFinish(c: Context) {
  const ticket = await ticketOf(c)
  if (!ticket) return fail(404, 'ticket_invalid')
  const label = typeof c.body.label === 'string' ? c.body.label.trim() : ''
  if (!LABEL.test(label)) return fail(400, 'label_invalid')
  let credential
  try {
    credential = await verifyRegistration(c.config, c.body.response, (challenge) => challengeIsOurs(c.env.CHALLENGE_KEY, 'enrol', ticket.id, challenge, c.now))
  } catch {
    return fail(400, 'passkey_rejected')
  }
  if (mustBeDeviceBound(ticket) && !credential.deviceBound) return fail(400, 'device_bound_required')
  const stored = await data.storePendingCredential(c.env.DB, ticket, credential, label, c.now).catch((error) => (labelTaken(error) ? 'label_taken' : false))
  if (stored !== true) return fail(409, stored || 'not_stored')
  // Shown on the member's device only. No route gives it to anyone else: the colleague types what they hear.
  const phrase = await phraseOf(c, { ...ticket, credential_id: credential.id, public_key: credential.publicKey })
  return json(200, { state: 'pending', phrase: phrase.words, confirmBy: c.now + data.CONFIRM_MS })
}

// The three words of a pending passkey, and its hash: what a confirmation challenge covers (recovery.md section 2).
async function phraseOf(c: Context, t: { org_id: string; seat_id: string; role: string; kind: string; nonce: string; credential_id: string; public_key: string }) {
  const hash = await credentialHash(t.credential_id, t.public_key)
  const words = await phraseFor({ site: c.config.rpId, orgId: t.org_id, seatId: t.seat_id, role: t.role, purpose: t.kind, credentialHash: hash, nonce: t.nonce })
  return { words, hash: toBase64Url(hash) }
}

// Takes no input and writes no row: it cannot tell anyone whether an account exists.
async function signinStart(c: Context) {
  return json(200, { options: requestOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'signin', '', c.now)) })
}

// One answer for every failure: unknown passkey, passkey not active, wrong site, stale or replayed challenge.
// Three more answers exist, and only for a passkey that passed its check: a replaced passkey is told so (it may
// stop its replacement, and opens no session), a passkey of a frozen seat is told who froze the seat and when
// (and opens no session either), and a passkey whose 72 hour wait is over becomes active here.
async function signinFinish(c: Context) {
  const denied = fail(401, 'sign_in_failed')
  const id = responseId(c)
  const credential = id ? await data.credentialById(c.env.DB, id) : null
  if (!credential) return denied
  const replaced = data.hasStopRight(credential, c.now)
  // The passkeys a frozen seat still holds: restored by a stop (active), or suspended by the freeze (no stop right date).
  const frozen = credential.seat_state === 'frozen' && (credential.state === 'active' || (credential.state === 'suspended' && credential.stop_right_until === null))
  if (!frozen && (credential.state === 'suspended' ? !replaced : credential.state === 'active' && credential.seat_state !== 'active')) return denied
  let used = ''
  const counter = await assertion(c, c.body.response, credential, 'signin', '', (challenge) => (used = challenge))
  if (counter === null) return denied
  // recovery: what this passkey would stop is a completed account recovery, not a re-enrolment of its own seat.
  if (replaced) return json(403, { error: 'passkey_replaced', until: credential.stop_right_until, recovery: Boolean(await data.recoveryToStop(c.env.DB, credential)) })
  if (frozen) {
    const [seat] = await data.frozenSeats(c.env.DB, credential.org_id, credential.seat_id)
    return json(403, { error: 'seat_frozen', by: seat?.by ?? null, at: seat?.at ?? null, stopped: seat?.stopped ?? false })
  }
  if (credential.state === 'pending' && !(await data.activateAfterWait(c.env.DB, credential, c.now))) return denied
  const token = data.randomToken()
  const cf = (c.request as Request<unknown, IncomingRequestCfProperties>).cf
  try {
    await data.createSession(c.env.DB, {
      orgId: credential.org_id, seatId: credential.seat_id, credentialId: credential.id, counter,
      tokenHash: await data.sha256Hex(token), challengeHash: await data.sha256Hex(used), now: c.now,
      userAgent: c.request.headers.get('user-agent')?.slice(0, 200) ?? null, country: cf?.country ?? null, asn: cf?.asn ?? null,
    })
  } catch {
    return denied
  }
  return json(200, { ok: true }, { 'set-cookie': cookie(token, ABSOLUTE_MS / 1000) })
}

// The stop right: a replaced passkey, after a normal passkey check, stops its replacement. No session is opened.
async function stopStart(c: Context) {
  return json(200, { options: requestOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'stop', '', c.now)) })
}
async function stopFinish(c: Context) {
  const denied = fail(401, 'sign_in_failed')
  const id = responseId(c)
  const credential = id ? await data.credentialById(c.env.DB, id) : null
  if (!credential) return denied
  // stopReplacement() checks the stop right itself, at the moment it writes.
  const counter = await assertion(c, c.body.response, credential, 'stop', '')
  if (counter === null || !(await data.stopReplacement(c.env.DB, credential, counter, c.now))) return denied
  return json(200, { ok: true })
}

async function me(c: Context) {
  const s = c.session
  return json(200, {
    organisation: { id: s.org_id, name: s.org_name, kind: s.org_kind, quarantineUntil: (s.org_quarantine_until ?? 0) > c.now ? s.org_quarantine_until : null },
    seat: { id: s.seat_id, displayName: s.display_name, role: s.role, keys: s.strong_keys, quarantineUntil: c.actor.quarantineUntil },
    session: { id: s.id, endsAt: s.created_at + ABSOLUTE_MS, stepUpUntil: s.step_up_at + STEP_UP_MS },
    // The quarantine alert says which one it is: the seat's own, or the organisation's after an account recovery.
    alerts: ((await data.alertsFor(c.env.DB, c.actor, c.now)) as data.Alert[]).map((alert) => (alert.kind === 'quarantine' && alert.until === s.org_quarantine_until ? { ...alert, detail: 'organisation' } : alert)),
  })
}

async function organisation(c: Context) {
  const view = await data.organisationView(c.env.DB, c.actor, c.now - IDLE_MS, c.now - ABSOLUTE_MS)
  return json(200, {
    ...view, tickets: await data.openTickets(c.env.DB, c.actor, c.now), currentSessionId: c.session.id,
    approvals: await data.openRequests(c.env.DB, c.actor, c.now),
    frozen: await data.frozenSeats(c.env.DB, c.actor.orgId),
    wallets: (await data.wallets(c.env.DB, c.actor.orgId, c.now)).map(walletView),
    chains: Object.keys(c.config.chains).map((id) => ({ id: Number(id), name: CHAIN_NAME[Number(id)] ?? `Chain ${id}` })),
    syncedKeysAllowed: c.session.synced_keys_allowed === 1, rights,
  })
}
async function revoke(c: Context) {
  const id = c.params.id ?? ''
  if (!(await data.revokeSession(c.env.DB, c.actor, id, 'session.revoke', c.now))) return fail(404, 'not_found')
  return json(200, { ok: true }, id === c.session.id ? { 'set-cookie': cookie('', 0) } : {})
}

async function signout(c: Context) {
  await data.revokeSession(c.env.DB, c.actor, c.session.id, 'session.signout', c.now)
  return json(200, { ok: true }, { 'set-cookie': cookie('', 0) })
}

// ---- step-up: a passkey check that starts the 5 minutes again and gives the session a new token ----

// The challenge is bound to the session's current token (its hash). A passed check replaces the token, so
// the same answer cannot pass twice, and an answer made for another session never passes.
const sessionBinding = (c: Context) => c.session.token_hash

async function stepupStart(c: Context) {
  return json(200, { options: await checkOptions(c, 'stepup', sessionBinding(c)) })
}
async function stepupFinish(c: Context) {
  const check = await ownAssertion(c, 'stepup', sessionBinding(c))
  if (!check) return fail(403, 'passkey_rejected')
  const token = data.randomToken()
  if (!(await data.stepUp(c.env.DB, c.actor, c.session.token_hash, { ...check, tokenHash: await data.sha256Hex(token), now: c.now }))) return fail(403, 'passkey_rejected')
  // The 12 hours still run from the sign-in.
  return json(200, { ok: true, stepUpUntil: c.now + STEP_UP_MS }, { 'set-cookie': cookie(token, Math.ceil((c.session.created_at + ABSOLUTE_MS - c.now) / 1000)) })
}

// ---- the member's own passkeys (path A: sign in with the second, revoke the lost one, add a replacement) ----

async function passkeyStart(c: Context) {
  const s = c.session
  const deviceBound = mustBeDeviceBound(s)
  const challenge = await newChallenge(c.env.CHALLENGE_KEY, 'add', sessionBinding(c), c.now)
  return json(200, { deviceBound, options: creationOptions(c.config, challenge, { id: s.seat_id, name: s.display_name }, deviceBound, await data.seatCredentialIds(c.env.DB, c.actor, false)) })
}
async function passkeyFinish(c: Context) {
  const label = typeof c.body.label === 'string' ? c.body.label.trim() : ''
  if (!LABEL.test(label)) return fail(400, 'label_invalid')
  let credential
  try {
    credential = await verifyRegistration(c.config, c.body.response, (challenge) => challengeIsOurs(c.env.CHALLENGE_KEY, 'add', sessionBinding(c), challenge, c.now))
  } catch {
    return fail(400, 'passkey_rejected')
  }
  if (mustBeDeviceBound(c.session) && !credential.deviceBound) return fail(400, 'device_bound_required')
  try {
    if (await data.addCredential(c.env.DB, c.actor, credential, label, c.now)) return json(200, { ok: true })
  } catch (error) {
    if (labelTaken(error)) return fail(409, 'label_taken')
    // otherwise the same passkey twice: the credential id is the primary key
  }
  return fail(409, 'not_stored')
}
async function passkeyRevoke(c: Context) {
  const outcome = await data.revokeCredential(c.env.DB, c.actor, c.params.id ?? '', c.now)
  return outcome === 'ok' ? json(200, { ok: true }) : refuse(outcome)
}

// ---- tickets issued by colleagues, and the three words ----

async function ticketIssue(c: Context) {
  const { seatId, displayName, role } = c.body
  const name = typeof displayName === 'string' ? displayName.trim() : ''
  const target =
    typeof seatId === 'string' && /^[0-9a-f]{32}$/.test(seatId) ? { seatId }
    : NAME.test(name) && data.ROLES.includes(role as data.Role) ? { displayName: name, role: role as data.Role }
    : null
  if (!target) return fail(400, 'invalid')
  // 256 random bits. It leaves the server once, here, inside a URL fragment; only its SHA-256 is stored.
  const token = data.randomToken()
  const issued = await data.issueTicket(c.env.DB, c.actor, target, await data.sha256Hex(token), c.now)
  if (issued.error) return refuse(issued.error)
  return json(200, { ...issued, link: `${c.config.origin}/#/enrol/${token}` })
}

// A confirmation is its own passkey check: the challenge covers the ticket, the hash of the pending passkey
// and the number of tries so far, so each try needs a new check and a check never serves another ticket.
async function ticketOpen(c: Context) {
  const ticket = await data.ticketToConfirm(c.env.DB, c.actor, c.params.id ?? '', c.now)
  if (!ticket) return fail(404, 'not_found')
  // Typing the words for a new member adds a member: blocked in quarantine. A re-enrolment stays open.
  if (ticket.kind === 'invitation' && (c.actor.quarantineUntil ?? 0) > c.now) return fail(403, 'quarantine')
  const phrase = await phraseOf(c, { ...ticket, org_id: c.actor.orgId, credential_id: ticket.credential_id!, public_key: ticket.public_key! })
  return { ticket, phrase, binding: `${ticket.id}.${phrase.hash}.${ticket.attempts}` }
}
async function confirmStart(c: Context) {
  const open = await ticketOpen(c)
  return open instanceof Response ? open : json(200, { options: await checkOptions(c, 'confirm', open.binding) })
}
async function confirmFinish(c: Context) {
  // Three words of the list, or it is a typing slip and no try is counted.
  const typed = typeof c.body.words === 'string' ? c.body.words.trim().toLowerCase().split(/\s+/) : []
  if (typed.length !== 3 || !typed.every((word) => WORDS.includes(word))) return fail(400, 'words_invalid')
  const open = await ticketOpen(c)
  if (open instanceof Response) return open
  const check = await ownAssertion(c, 'confirm', open.binding)
  if (!check) return fail(403, 'passkey_rejected')
  const outcome = await data.confirmTicket(c.env.DB, c.actor, open.ticket, { ...check, correct: typed.join(' ') === open.phrase.words.join(' '), credentialHash: open.phrase.hash, now: c.now })
  if (outcome.state === 'wrong') return json(400, { error: 'wrong_words', left: outcome.left })
  if (outcome.state === 'dead') return fail(410, 'ticket_dead')
  if (outcome.state === 'gone') return fail(409, 'try_again')
  return json(200, outcome)
}
async function ticketCancel(c: Context) {
  return (await data.cancelTicket(c.env.DB, c.actor, c.params.id ?? '', c.now)) ? json(200, { ok: true }) : fail(404, 'not_found')
}

// ---- milestone 3: freeze, changes for two people, the audit log ----

// A freeze (one person), or one of the changes that need two. For the passkey rule the subject is the session's
// organisation; for the rest it is the seat in the path. The new value is a role, or '1' (synced passkeys allowed) or '0'.
async function change(c: Context, kind: data.Kind | data.Direct) {
  const value = kind === 'seat.role' ? c.body.role : kind === 'policy.synced_keys' && typeof c.body.syncedKeys === 'boolean' ? (c.body.syncedKeys ? '1' : '0') : null
  const subject = kind === 'policy.synced_keys' ? c.actor.orgId : c.params.id ?? ''
  const outcome = await data.change(c.env.DB, c.actor, kind, subject, typeof value === 'string' ? value : null, c.now, kind === 'anchor.set' ? await snapshotOf(c, subject) : null)
  return 'error' in outcome ? refuse(outcome.error) : json(200, outcome)
}
const decide = (decision: 'approve' | 'reject' | 'cancel') => async (c: Context) => {
  const id = c.params.id ?? ''
  const outcome = await data.decide(c.env.DB, c.actor, id, decision, c.now, decision === 'approve' ? await snapshotOf(c, id) : null)
  return outcome === 'ok' ? json(200, decision === 'approve' ? { state: 'applied' } : { ok: true }) : refuse(outcome)
}

// ---- milestone 4a: wallets, the proof of the signing page, the recovery wallet ----

const WEEK_S = 7 * 24 * 60 * 60
const INTENT = 'wallet-intent' // the label of an intent under the challenge key
/** What a manager asked for, signed by the server and held nowhere. Times are Unix seconds, as the wallet signs them. */
interface Intent { org: string; seat: string; chainId: number; wallet: string; label: string; custodian: boolean; nonce: string; issuedAt: number; expiresAt: number; site: string }

// Writes nothing. The link goes to the people who hold the wallet; the wallet row appears when its signature does.
async function walletIntent(c: Context) {
  const { chainId, custodian } = c.body
  const address = parseAddress(c.body.address)
  const label = typeof c.body.label === 'string' ? c.body.label.trim() : ''
  if (typeof chainId !== 'number' || !Object.hasOwn(c.config.chains, chainId)) return fail(400, 'chain_invalid')
  if (!address) return fail(400, 'address_invalid')
  if (!LABEL.test(label)) return fail(400, 'label_invalid')
  if (typeof custodian !== 'boolean') return fail(400, 'invalid')
  if (await data.walletLive(c.env.DB, c.actor.orgId, chainId, address, c.now)) return fail(409, 'already_linked')
  const issuedAt = Math.floor(c.now / 1000)
  const intent: Intent = {
    org: c.actor.orgId, seat: c.actor.seatId, chainId, wallet: checksum(address), label, custodian,
    nonce: `0x${data.randomId()}${data.randomId()}`, issuedAt, expiresAt: issuedAt + WEEK_S, site: c.config.rpId,
  }
  const sealed = await seal(c.env.CHALLENGE_KEY, INTENT, intent)
  return json(200, { intent: sealed, link: `${c.config.signOrigin}/sign/#${sealed}`, expiresAt: intent.expiresAt * 1000 })
}

// The one route of the signing host. No session and no cookie: the caller proves nothing about itself. The intent
// is the server's own text (a wallet link made for a signed-in manager, or a recovery intent anyone may ask for); its
// MAC is checked first, before anything is read from the database or asked of an endpoint. Then its expiry, then the
// counter: 10 proof checks per organisation per hour, the only write before the commit. Then the kind decides.
async function proof(c: Context) {
  const sealed = typeof c.body.intent === 'string' ? c.body.intent : ''
  const link = (await unseal(c.env.CHALLENGE_KEY, INTENT, sealed)) as Intent | null
  const recover = link ? null : ((await unseal(c.env.CHALLENGE_KEY, RECOVER, sealed)) as RecoverIntent | null)
  const intent = link ?? recover
  if (!intent) return fail(400, 'intent_invalid')
  if (intent.expiresAt * 1000 <= c.now) return fail(410, 'intent_expired')
  if (!(await data.countProof(c.env.DB, intent.org, c.now))) return fail(429, 'too_many')
  const { signature } = c.body
  if (typeof signature !== 'string' || signature.length > 8194 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)) return fail(400, 'signature_invalid')
  return link ? linkProof(c, link, signature as `0x${string}`) : recoveryProof(c, recover!, signature as `0x${string}`)
}

// A wallet link: the wallet's signature, over typed data rebuilt from the intent.
async function linkProof(c: Context, intent: Intent, signature: `0x${string}`) {
  const endpoints = c.config.chains[intent.chainId]
  if (!endpoints) return fail(400, 'signature_invalid')
  // The site is this environment's constant; every other field was under the MAC. Nothing here is the caller's text.
  const typed = typedLink({ chainId: intent.chainId, site: c.config.rpId, organisationId: intent.org, wallet: intent.wallet, nonce: intent.nonce, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt })
  const proved = await verify(endpoints, typed, intent.wallet, signature)
  if (!proved) return fail(403, 'signature_rejected')
  // A wallet whose own key signed is never read as a Safe: no endpoint is asked about it. A contract is a Safe only
  // when it is a genuine one (chain.ts). Any other contract is stored as a single key, the strictest kind, whatever
  // the requester declared: what answers for it cannot be checked, and "custodian" is the word for a key a custodian holds.
  const safe = proved.by === 'contract' ? await safeState(endpoints, intent.chainId, intent.wallet) : null
  const outcome = await data.linkWallet(c.env.DB, {
    orgId: intent.org, seatId: intent.seat, chainId: intent.chainId, address: intent.wallet.toLowerCase(), label: intent.label,
    kind: safe ? 'safe' : intent.custodian && proved.by === 'key' ? 'custodian' : 'single_key', snapshot: safe && JSON.stringify(safe),
    nonce: intent.nonce, digest: proved.digest, signature, now: c.now,
  })
  return 'error' in outcome ? refuse(outcome.error) : json(200, outcome)
}

// ---- milestone 4b: last-Owner recovery (recovery.md sections 4 and 5) ----

const ID = /^[0-9a-f]{32}$/
const RECOVER = 'recover-intent' // the label of a recovery intent under the challenge key
const NO_HASH = `0x${'0'.repeat(64)}`
/** What /recover asked for, signed by the server and held nowhere. A cancel names the request's nonce and no passkey. */
interface RecoverIntent {
  kind: ProofKind; org: string; nonce: string; credentialHash: string; phrase: string; issuedAt: number; expiresAt: number; site: string
  seat?: string; credential?: data.RecoveryAsk['credential']
}
const sealedRecover = async (c: Context, fields: Omit<RecoverIntent, 'issuedAt' | 'expiresAt' | 'site'>) => {
  const issuedAt = Math.floor(c.now / 1000)
  const sealed = await seal(c.env.CHALLENGE_KEY, RECOVER, { ...fields, issuedAt, expiresAt: issuedAt + WEEK_S, site: c.config.rpId } satisfies RecoverIntent)
  return { intent: sealed, link: `${c.config.signOrigin}/sign/#${sealed}`, expiresAt: (issuedAt + WEEK_S) * 1000 }
}

// The start of a last-Owner recovery, for anyone: no session, and the server writes nothing and reads no row. It
// answers the same for any well-formed organisation id, so it says nothing about any organisation. First call:
// the options for a new device-bound passkey, for a seat id made here. Second call: that passkey's registration
// in, a MAC-signed intent out, with the three words its holder reads to the signers of the recovery wallet.
// ponytail: Turnstile comes before this route in production (recovery.md section 4); it is not built. Until then
// anyone can ask for intents; each costs a passkey registration, writes nothing, and its proofs are counted per organisation.
async function recoverIntent(c: Context) {
  const { organisationId: org, seat } = c.body
  if (typeof org !== 'string' || !ID.test(org)) return fail(400, 'invalid')
  if (typeof seat !== 'string' || !ID.test(seat)) {
    const made = data.randomId()
    const challenge = await newChallenge(c.env.CHALLENGE_KEY, 'recover', `${org}.${made}`, c.now)
    return json(200, { seat: made, options: creationOptions(c.config, challenge, { id: made, name: 'Recovery Owner' }, true) })
  }
  let credential
  try {
    credential = await verifyRegistration(c.config, c.body.response, (challenge) => challengeIsOurs(c.env.CHALLENGE_KEY, 'recover', `${org}.${seat}`, challenge, c.now))
  } catch {
    return fail(400, 'passkey_rejected')
  }
  if (!credential.deviceBound) return fail(400, 'device_bound_required') // the new passkey is an Owner's
  const nonce = data.randomId() + data.randomId()
  const hash = await credentialHash(credential.id, credential.publicKey)
  const words = await phraseFor({ site: c.config.rpId, orgId: org, seatId: seat, role: 'owner', purpose: 'recovery', credentialHash: hash, nonce })
  const sealed = await sealedRecover(c, {
    kind: c.body.override === true ? 'override' : 'replace', org, seat, nonce: `0x${nonce}`, phrase: words.join(' '),
    credentialHash: `0x${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports },
  })
  return json(200, { ...sealed, phrase: words })
}
// The same for a cancel by the recovery wallet: an organisation id and the nonce of the request in, an intent out.
// Nothing is read: whether such a request exists is decided when the wallet's signature arrives.
async function recoverCancelIntent(c: Context) {
  const { organisationId: org, nonce } = c.body
  if (typeof org !== 'string' || !ID.test(org) || typeof nonce !== 'string' || !/^0x[0-9a-f]{64}$/.test(nonce)) return fail(400, 'invalid')
  return json(200, await sealedRecover(c, { kind: 'cancel', org, nonce, credentialHash: NO_HASH, phrase: '' }))
}

// A recovery proof, after the MAC, the expiry and the counter. The rows first (recoverable(), or the open request a
// cancel names), so that no endpoint is asked for a request that cannot open; then the signature, over typed data
// rebuilt from the intent and from the recovery wallet the server holds, never from the caller's text; then the Safe
// as both endpoints see it; then one commit, which reads the rows again. Until the signature is valid every refusal
// is the same answer: the caller is anyone, and learns nothing about the organisation.
async function recoveryProof(c: Context, intent: RecoverIntent, signature: `0x${string}`) {
  const rejected = fail(403, 'proof_rejected')
  const ask = intent.kind !== 'cancel' && intent.seat && intent.credential
    ? { orgId: intent.org, override: intent.kind === 'override', seatId: intent.seat, credential: intent.credential, credentialHash: intent.credentialHash, nonce: intent.nonce } : null
  let wallet: data.Anchor | null = null
  if (ask) {
    const can = await data.recoverable(c.env.DB, ask, c.now)
    if ('wallet' in can) wallet = can.wallet
  } else if (intent.kind === 'cancel') {
    const open = await data.recoveryRow(c.env.DB, intent.org, c.now, 'nonce', intent.nonce)
    wallet = open && { ...open, id: open.wallet_id }
  }
  const endpoints = wallet ? c.config.chains[wallet.chainId] : undefined
  if (!wallet || !endpoints) return rejected
  const typed = typedProof({
    kind: intent.kind, chainId: wallet.chainId, site: c.config.rpId, organisationId: intent.org, wallet: checksum(wallet.address),
    credentialHash: intent.credentialHash, phrase: intent.phrase, nonce: intent.nonce, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt,
  })
  const proved = await verify(endpoints, typed, wallet.address, signature)
  if (!proved) return rejected
  if (!ask) return (await data.cancelRecovery(c.env.DB, intent.org, { nonce: intent.nonce }, '', c.now)) === 'ok' ? json(200, { state: 'cancelled' }) : rejected
  const live = wallet.kind === 'safe' ? await safeState(endpoints, wallet.chainId, wallet.address) : null
  const outcome = await data.openRecovery(c.env.DB, ask, { walletId: wallet.id, digest: proved.digest, signature, live }, c.now)
  return 'error' in outcome ? refuse(outcome.error) : json(200, outcome)
}

// Completion, on /recover: a normal passkey check against the pending passkey. Start takes no input and writes nothing.
async function continueStart(c: Context) {
  return json(200, { options: requestOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'continue', '', c.now)) })
}
// One answer for every failure, as at sign-in, and two more for a passkey that passed its check: the wait still runs
// (with its end), or the request has lapsed. The proof is verified again, from the digest the server stored, and
// the wallet is read on both endpoints: a proof that no longer verifies, or a Safe that cannot be read, completes
// nothing and changes nothing; a Safe that differs from the snapshot (owners, threshold, modules, handler) makes the
// request lapse.
async function continueFinish(c: Context) {
  const denied = fail(401, 'sign_in_failed')
  const id = responseId(c)
  const credential = id ? await data.credentialById(c.env.DB, id) : null
  if (!credential || credential.state !== 'pending' || credential.ticket_id) return denied
  let used = ''
  const counter = await assertion(c, c.body.response, credential, 'continue', '', (challenge) => (used = challenge))
  const r = counter === null ? null : await data.recoveryRow(c.env.DB, credential.org_id, c.now, 'seat_id', credential.seat_id)
  if (counter === null || !r) return denied
  if (r.wait_until > c.now) return json(409, { error: 'too_early', until: r.wait_until })
  const endpoints = c.config.chains[r.chainId]
  const proved = endpoints && (await verifyDigest(endpoints, r.chainId, r.digest as `0x${string}`, r.address, r.signature as `0x${string}`))
  const live = proved && r.kind === 'safe' ? await safeState(endpoints, r.chainId, r.address) : null
  if (!proved || (r.kind === 'safe' && !live)) return fail(409, 'wallet_unreadable')
  // An override was green at its proof. Unchanged since, it is green now: the snapshot of its approval cannot change while it is in force.
  const same = JSON.stringify(live) === r.owners_snapshot
  const token = data.randomToken()
  const cf = (c.request as Request<unknown, IncomingRequestCfProperties>).cf
  const outcome = await data.completeRecovery(c.env.DB, {
    orgId: credential.org_id, seatId: credential.seat_id, credentialId: credential.id, counter, same,
    tokenHash: await data.sha256Hex(token), challengeHash: await data.sha256Hex(used),
    userAgent: c.request.headers.get('user-agent')?.slice(0, 200) ?? null, country: cf?.country ?? null, asn: cf?.asn ?? null,
  }, c.now).catch(() => 'denied' as const)
  return outcome === 'completed' ? json(200, { ok: true }, { 'set-cookie': cookie(token, ABSOLUTE_MS / 1000) }) : outcome === 'lapsed' ? fail(410, 'recovery_lapsed') : denied
}
const recoveryCancel = async (c: Context) => {
  const outcome = await data.cancelRecovery(c.env.DB, c.actor.orgId, c.actor, c.params.id ?? '', c.now)
  return outcome === 'ok' ? json(200, { ok: true }) : refuse(outcome)
}
const recoveryObject = async (c: Context) => {
  const outcome = await data.objectRecovery(c.env.DB, c.actor, c.params.id ?? '', c.now)
  return outcome === 'ok' ? json(200, { ok: true }) : refuse(outcome)
}

// The Safe as both endpoints see it now, for a wallet that is about to become the recovery wallet (by its id, or by
// the id of the request that asks for it). Null: not a Safe, or not readable; the data module then refuses a Safe.
async function snapshotOf(c: Context, id: string) {
  const w = await data.walletFor(c.env.DB, c.actor, id, c.now)
  const endpoints = w?.kind === 'safe' ? c.config.chains[w.chainId] : undefined
  const state = endpoints ? await safeState(endpoints, w!.chainId, w!.address) : null
  return state && JSON.stringify(state)
}

// Readiness to recover (recovery.md section 10, without the spare key). The recovery wallet is read on both endpoints
// now, on demand: its colour is never stored.
async function readiness(c: Context) {
  const { owners, wallet } = await data.readiness(c.env.DB, c.actor, c.now)
  const people = owners.some((keys) => keys < 2) ? 'red' : owners.length > 1 ? 'green' : 'amber'
  const inForce = wallet?.recovery === 'in_force'
  const endpoints = wallet?.kind === 'safe' && inForce ? c.config.chains[wallet.chainId] : undefined
  const live = endpoints ? await safeState(endpoints, wallet!.chainId, wallet!.address) : null
  const shade = wallet ? colour({ ...wallet, inForce }, live) : { level: 'none' as const, why: null }
  const overall = people === 'green' || (people === 'amber' && shade.level === 'green') ? 'ready' : owners.length === 1 && !wallet ? 'not_recoverable' : 'at_risk'
  // The one step that comes next: the second key of an Owner (without it that Owner can set nothing), then the recovery wallet where there is one Owner and none, then a second Owner.
  const step = overall === 'ready' ? null : people === 'red' ? 'second_key' : overall === 'not_recoverable' ? 'recovery_wallet' : 'second_owner'
  return json(200, {
    owners: { level: people, count: owners.length }, overall, step,
    wallet: { ...shade, label: wallet?.label ?? null, at: wallet?.recoveryAt ?? null, ...(live && { threshold: live.threshold, owners: live.owners.length }) },
    // For the recovery sheet: nothing here is secret.
    sheet: { organisationId: c.actor.orgId, console: c.config.origin, signPage: `${c.config.signOrigin}/sign/`, wallet: wallet && inForce ? { address: checksum(wallet.address), chain: CHAIN_NAME[wallet.chainId] ?? `Chain ${wallet.chainId}` } : null },
  })
}
const walletView = ({ snapshot, ...w }: Awaited<ReturnType<typeof data.wallets>>[number]) => {
  const seen = snapshot ? (JSON.parse(snapshot) as SafeState) : null
  return { ...w, address: checksum(w.address), ...(seen && { threshold: seen.threshold, owners: seen.owners.length }) }
}

const ROLE_NAME: Record<string, string> = { owner: 'Owner', admin: 'Admin', trader: 'Trader', approver: 'Approver', compliance: 'Compliance officer', viewer: 'Viewer' }
const CHANGES: Record<string, string> = {
  'seat.unfreeze': 'unfreeze a seat', 'seat.remove': 'remove a member', 'seat.role': 'change a role', 'policy.synced_keys': 'change the passkey rule for key roles',
  'wallet.link': 'link a wallet', 'anchor.set': 'set the recovery wallet',
}
// The one table that turns an audit action into words, for the page and the export alike: neither ever shows a
// code. A key with a slash is the action with that detail. A test fails if data.ts writes an action that is not here.
export const EVENTS: Record<string, string> = {
  'organisation.seed': 'Organisation created',
  'credential.store': 'Passkey created, waiting for confirmation',
  'credential.activate': 'Passkey confirmed, now active',
  'credential.activate/wait': 'Passkey active after the 72 hour wait',
  'credential.activate.dev': 'Passkey activated by the local command',
  'credential.add': 'Passkey added to the own seat',
  'credential.revoke': 'Passkey revoked',
  'credential.stop': 'Replacement stopped by a replaced passkey, seat frozen',
  'session.create': 'Signed in',
  'session.create/ticket_killed': 'Signed in, an open re-enrolment of the seat was closed',
  'session.stepup': 'Passkey check passed',
  'session.revoke': 'Session ended',
  'session.signout': 'Signed out',
  'ticket.issue': 'Enrolment link issued',
  'ticket.issue/re_enrolment': 'Re-enrolment link issued',
  'ticket.attempt': 'Wrong words typed',
  'ticket.attempt/dead': 'Wrong words typed three times, enrolment cancelled',
  'ticket.confirm': 'Words confirmed, waiting for a second person',
  'ticket.confirm/wait': 'Words confirmed, the 72 hour wait started',
  'ticket.cancel': 'Enrolment cancelled',
  'seat.freeze': 'Seat frozen',
  'seat.unfreeze': 'Seat unfrozen',
  'seat.remove': 'Member removed',
  'seat.remove/invited': 'Invited seat removed before anyone enrolled',
  'seat.role': 'Role changed',
  'policy.synced_keys': 'Passkey rule for key roles changed',
  'policy.synced_keys/synced': 'Passkey rule for key roles changed: synced passkeys allowed',
  'policy.synced_keys/hardware': 'Passkey rule for key roles changed: hardware keys only',
  'approval.request': 'Change requested',
  'approval.reject': 'Change rejected',
  'approval.cancel': 'Request cancelled by its requester',
  'audit.export': 'Audit log exported',
  'wallet.link': 'Wallet linked',
  'wallet.link/alone': 'Wallet linked by the only key-role member',
  'wallet.unlink': 'Wallet unlinked',
  'anchor.set': 'Recovery wallet set, in force after 72 hours',
  'anchor.set/alone': 'Recovery wallet set by the only key-role member, in force after 72 hours',
  'anchor.cancel': 'Change of recovery wallet cancelled',
  'recovery.open': 'Account recovery requested by the recovery wallet, 72 hour wait started',
  'recovery.open/override': 'Account recovery requested by the recovery wallet, overriding the Owners, 72 hour wait started',
  'recovery.cancel': 'Account recovery cancelled by an Owner',
  'recovery.cancel/wallet': 'Account recovery cancelled by the recovery wallet',
  'recovery.object': 'Objection to the account recovery, 72 hours added',
  'recovery.complete': 'Account recovery completed: new Owner signed in, the other Owner passkeys suspended, organisation in quarantine for 7 days',
  'recovery.complete/override': 'Account recovery completed, overriding the Owners: new Owner signed in, the other Owners removed, organisation in quarantine for 7 days',
  'recovery.lapse': 'Account recovery lapsed: the recovery wallet changed since the request',
  'recovery.stop': 'Account recovery stopped by a replaced Owner passkey: the new Owner removed, the Owner passkeys restored',
}
function said(action: string, detail: string | null) {
  const words = EVENTS[`${action}/${detail}`] ?? EVENTS[action] ?? 'Unlisted event'
  if (action.startsWith('approval.') && detail && CHANGES[detail]) return `${words}: ${CHANGES[detail]}`
  const [from, to] = action === 'seat.role' && detail ? detail.split('.') : []
  return ROLE_NAME[from] && ROLE_NAME[to] ? `${words}: ${ROLE_NAME[from]} to ${ROLE_NAME[to]}` : words
}
const line = (r: data.AuditLine) => ({ seq: r.seq, at: r.at, who: r.who ?? 'System', event: said(r.action, r.detail), target: r.target ?? '', prevHash: r.prevHash, hash: r.hash })

const PAGE = 50
// ponytail: the chain is verified in full on every page (verifyAudit reads it whole). Same ceiling: about 10,000 rows.
async function audit(c: Context) {
  const cursor = new URL(c.request.url).searchParams.get('before') ?? ''
  const rows = await data.auditRows(c.env.DB, c.actor, /^[1-9]\d{0,14}$/.test(cursor) ? Number(cursor) : null, PAGE)
  const chain = await data.verifyAudit(c.env.DB, c.actor.orgId)
  const last = rows.at(-1)?.seq ?? 1
  return json(200, { rows: rows.map(line), next: rows.length === PAGE && last > 1 ? last : null, chain })
}
/** Every cell is quoted. One that a spreadsheet would run as a formula (it starts with = + - @, a tab or a return) gets an apostrophe in front. */
export const csvCell = (value: unknown) => {
  const text = String(value ?? '')
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`
}
// ponytail: the whole log in one answer. Page it, or stream it, when a log passes about 10,000 rows.
async function auditExport(c: Context) {
  const rows = (await data.exportAudit(c.env.DB, c.actor, c.now)).map(line)
  const utc = (time: number) => `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')}Z`
  const lines = [['No.', 'Time (UTC)', 'Who', 'Event', 'Target', 'Previous row hash', 'Row hash'], ...rows.map((r) => [r.seq, utc(r.at), r.who, r.event, r.target, r.prevHash, r.hash])]
  return json(200, { name: `ophis-audit-log-${new Date(c.now).toISOString().slice(0, 10)}.csv`, csv: lines.map((cells) => `${cells.map(csvCell).join(',')}\r\n`).join('') })
}

const ANY = data.ROLES
const MANAGERS: readonly data.Role[] = ['owner', 'admin']
const READERS: readonly data.Role[] = ['owner', 'compliance', 'viewer']
const SELF = 'Sign in, pass a passkey check, sign out'
const ADD = 'Add a passkey to the own seat'
const WORDS3 = 'Type the three words that confirm a colleague\'s new passkey'
// The route table, which is the role table. A state change is a POST. tests/worker.test.ts fails if a route is
// missing from its copy of this table, or has no isolation case.
export const routes: Route[] = [
  { method: 'POST', path: '/api/enrol/start', roles: 'public', handler: enrolStart },
  { method: 'POST', path: '/api/enrol/finish', roles: 'public', handler: enrolFinish },
  { method: 'POST', path: '/api/signin/start', roles: 'public', handler: signinStart },
  { method: 'POST', path: '/api/signin/finish', roles: 'public', handler: signinFinish },
  { method: 'GET', path: '/api/me', roles: ANY, can: SELF, handler: me },
  { method: 'GET', path: '/api/org', roles: ANY, can: 'See the own seat, its passkeys and sessions (Owner and Admin: those of every member)', handler: organisation },
  { method: 'POST', path: '/api/sessions/:id/revoke', roles: ANY, can: 'End a session of the own seat (Owner and Admin: of any member)', handler: revoke },
  { method: 'POST', path: '/api/signout', roles: ANY, can: SELF, handler: signout },
  { method: 'POST', path: '/api/stepup/start', roles: ANY, can: SELF, handler: stepupStart },
  { method: 'POST', path: '/api/stepup/finish', roles: ANY, can: SELF, handler: stepupFinish },
  { method: 'POST', path: '/api/passkeys/start', roles: ANY, fresh: true, can: ADD, handler: passkeyStart },
  { method: 'POST', path: '/api/passkeys/finish', roles: ANY, fresh: true, can: ADD, handler: passkeyFinish },
  { method: 'POST', path: '/api/passkeys/:id/revoke', roles: ANY, fresh: true, twoKeys: true, can: 'Revoke a passkey of the own seat, never the last (Owner and Admin: also of a member at or below their role)', handler: passkeyRevoke },
  { method: 'POST', path: '/api/tickets', roles: MANAGERS, fresh: true, twoKeys: true, can: 'Invite a member, or re-enrol one who lost every passkey', handler: ticketIssue },
  { method: 'POST', path: '/api/tickets/:id/confirm/start', roles: data.KEY_ROLES, twoKeys: true, can: WORDS3, handler: confirmStart },
  { method: 'POST', path: '/api/tickets/:id/confirm', roles: data.KEY_ROLES, twoKeys: true, can: WORDS3, handler: confirmFinish },
  { method: 'POST', path: '/api/tickets/:id/cancel', roles: ['owner'], fresh: true, twoKeys: true, can: 'Cancel an enrolment that waits', handler: ticketCancel },
  { method: 'POST', path: '/api/stop/start', roles: 'public', handler: stopStart },
  { method: 'POST', path: '/api/stop/finish', roles: 'public', handler: stopFinish },
  { method: 'POST', path: '/api/members/:id/freeze', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, can: 'Freeze a seat at once, in an emergency (Admin: a seat at or below Admin)', handler: (c) => change(c, 'seat.freeze') },
  { method: 'POST', path: '/api/members/:id/unfreeze', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, second: 'seat.unfreeze', can: 'Ask to unfreeze a seat' },
  { method: 'POST', path: '/api/members/:id/role', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, second: 'seat.role', can: 'Ask to change a member\'s role, never above the own role' },
  { method: 'POST', path: '/api/members/:id/remove', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, second: 'seat.remove', can: 'Ask to remove a member (an invited seat nobody enrolled on: removed at once)' },
  { method: 'POST', path: '/api/policy', roles: ['owner'], fresh: true, twoKeys: true, settled: true, second: 'policy.synced_keys', can: 'Ask to change the passkey rule for key roles' },
  { method: 'POST', path: '/api/approvals/:id/approve', roles: data.KEY_ROLES, fresh: true, twoKeys: true, settled: true, can: 'Approve a colleague\'s request as the second person', handler: decide('approve') },
  { method: 'POST', path: '/api/approvals/:id/reject', roles: data.KEY_ROLES, fresh: true, twoKeys: true, can: 'Reject a colleague\'s request', handler: decide('reject') },
  { method: 'POST', path: '/api/approvals/:id/cancel', roles: MANAGERS, can: 'Cancel the own request', handler: decide('cancel') },
  { method: 'POST', path: '/api/wallets/intent', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, can: 'Start the link of a wallet, which the wallet then proves with a signature', handler: walletIntent },
  { method: 'POST', path: '/api/wallets/:id/unlink', roles: MANAGERS, fresh: true, twoKeys: true, can: 'Unlink a wallet, never the recovery wallet', handler: (c) => change(c, 'wallet.unlink') },
  { method: 'POST', path: '/api/wallets/:id/anchor', roles: ['owner'], fresh: true, twoKeys: true, settled: true, second: 'anchor.set', can: 'Ask to make a linked wallet the recovery wallet' },
  { method: 'POST', path: '/api/wallets/:id/anchor/cancel', roles: ['owner'], fresh: true, twoKeys: true, can: 'Cancel a change of recovery wallet during its 72 hours', handler: (c) => change(c, 'anchor.cancel') },
  { method: 'GET', path: '/api/readiness', roles: ['owner'], can: 'See how ready the organisation is to recover access', handler: readiness },
  { method: 'POST', path: '/api/proof', roles: 'public', sign: true, handler: proof },
  { method: 'POST', path: '/api/recover/intent', roles: 'public', handler: recoverIntent },
  { method: 'POST', path: '/api/recover/cancel-intent', roles: 'public', handler: recoverCancelIntent },
  { method: 'POST', path: '/api/recover/continue/start', roles: 'public', handler: continueStart },
  { method: 'POST', path: '/api/recover/continue/finish', roles: 'public', handler: continueFinish },
  { method: 'POST', path: '/api/recovery/:id/cancel', roles: ['owner'], fresh: true, can: 'Cancel an account recovery that is open (never one that overrides the Owners)', handler: recoveryCancel },
  { method: 'POST', path: '/api/recovery/:id/object', roles: ['admin', 'approver', 'compliance'], fresh: true, can: 'Object once to an account recovery that waits, which adds 72 hours', handler: recoveryObject },
  { method: 'GET', path: '/api/audit', roles: READERS, can: 'Read the audit log', handler: audit },
  { method: 'POST', path: '/api/audit/export', roles: READERS, fresh: true, can: 'Export the audit log', handler: auditExport },
]
// "What each role can do": the rows of the table above that a session can reach. Routes that share a sentence are one row.
const rights = [...new Map(routes.flatMap((r) => (r.can ? [[r.can, { can: r.can, roles: r.roles, fresh: Boolean(r.fresh), second: Boolean(r.second) }] as const] : []))).values()]
const patterns = routes.map((route) => new URLPattern({ pathname: route.path }))

async function sessionOf(request: Request, env: Env, now: number) {
  const token = request.headers.get('cookie')?.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  if (!token) return null
  const token_hash = await data.sha256Hex(token)
  const session = await data.sessionByToken(env.DB, token_hash)
  if (!session) return null
  // Both limits are the server's: 15 minutes idle, 12 hours from sign-in.
  if (now - session.last_seen_at > IDLE_MS || now - session.created_at > ABSOLUTE_MS) return null
  // ponytail: the idle clock is written at most once a minute to spare D1 writes, so a session can
  // end up to 60 s early, never late. Write on every request if that minute ever matters.
  if (now - session.last_seen_at >= TOUCH_MS) await data.touchSession(env.DB, { orgId: session.org_id, sessionId: session.id }, now)
  return { ...session, token_hash }
}

async function api(request: Request, env: Env, clock: () => number, config: Config, signing: boolean): Promise<Response> {
  // Every API route, GET included. A sibling *.ophis.fi host is same-site, so same-site is not enough.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return fail(403, 'cross_site')
  const { pathname } = new URL(request.url)
  // Each host has its own routes: the signing host answers the proof route and no other, the console host every other.
  const index = routes.findIndex((route, i) => route.method === request.method && Boolean(route.sign) === signing && patterns[i].test({ pathname }))
  if (index < 0) return fail(404, 'not_found')
  const route = routes[index]
  let body: Record<string, unknown> = {}
  if (route.method === 'POST') {
    if (request.headers.get('origin') !== (signing ? config.signOrigin : config.origin)) return fail(403, 'bad_origin')
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
  // Read once the body has arrived: a slow sender cannot stretch a challenge, a ticket or a session past its end.
  const now = clock()
  const context = { request, env, now, config, body, params: patterns[index].exec({ pathname })?.pathname.groups ?? {} } as Context
  if (route.roles !== 'public') {
    const session = await sessionOf(request, env, now)
    if (!session) return fail(401, 'signed_out')
    const cf = (request as Request<unknown, IncomingRequestCfProperties>).cf
    context.session = session
    // The organisation of every later query comes from here, never from the request.
    context.actor = {
      orgId: session.org_id, seatId: session.seat_id, sessionId: session.id, role: session.role,
      country: cf?.country ?? null, asn: cf?.asn ?? null,
      // The seat's own quarantine (after its re-enrolment), or the organisation's (7 days after a last-Owner recovery),
      // whichever ends later: during the second, what a seat in quarantine cannot do is refused for every seat.
      quarantineUntil: Math.max(session.quarantine_until ?? 0, session.org_quarantine_until ?? 0) > now ? Math.max(session.quarantine_until ?? 0, session.org_quarantine_until ?? 0) : null,
    }
    // The role table, enforced here for every route: the role, then the gates of the row.
    if (!route.roles.includes(session.role)) return fail(403, 'forbidden')
    if (route.twoKeys && session.strong_keys < 2) return fail(403, 'second_key_required')
    if (route.settled && context.actor.quarantineUntil) return fail(403, 'quarantine')
    if (route.fresh && now - session.step_up_at > STEP_UP_MS) return fail(403, 'step_up_required')
  }
  // A change for two people has no handler of its own: all this route can do is file the request.
  return route.second ? change(context, route.second) : route.handler!(context)
}

// The pages. Each host serves its own and nothing of the other's: the signing host the signing page under /sign/
// (with its script, style, icon and manifest.json), the console host everything else.
async function pages(request: Request, env: Env, signing: boolean) {
  const { pathname } = new URL(request.url)
  if (signing !== (pathname === '/sign' || pathname.startsWith('/sign/'))) return new Response('Not found', { status: 404, headers: HEADERS })
  // /recover is a page of the console's one shell (the app reads the path): public, and it needs no session.
  const asset = await env.ASSETS.fetch(!signing && pathname === '/recover' ? new Request(new URL('/', request.url), request) : request)
  if (!signing) return asset // public/_headers sets the console's headers
  const headers = new Headers(SIGN_HEADERS)
  for (const name of ['content-type', 'location', 'etag']) if (asset.headers.has(name)) headers.set(name, asset.headers.get(name)!)
  if (pathname === '/sign/manifest.json') headers.set('access-control-allow-origin', '*')
  return new Response(asset.body, { status: asset.status, headers })
}

/** `now` is injectable so that tests own the clock. */
export async function handle(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  const { pathname, origin } = new URL(request.url)
  let response: Response
  try {
    const config = configFor(env.ENVIRONMENT)
    // The host decides, from the environment's constants: the signing page's own hostname, or the console.
    const signing = origin === config.signOrigin
    // Any other host is not ours: a request that arrives under another name gets nothing, not even a refusal with a reason.
    if (!signing && origin !== config.origin) return new Response('Not found', { status: 404, headers: HEADERS })
    if (!pathname.startsWith('/api/')) return await pages(request, env, signing)
    response = await api(request, env, now, config, signing)
  } catch (error) {
    // Logs carry route names and error names only: no ids of people, no values, no tokens.
    console.error('api failure', request.method, pathname, error instanceof Error ? error.name : 'unknown')
    response = fail(500, 'internal')
  }
  response = new Response(response.body, response)
  for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value)
  return response
}

export default { fetch: (request: Request, env: Env) => handle(request, env) } satisfies ExportedHandler<Env>
