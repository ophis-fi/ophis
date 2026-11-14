// Worker entry: answers /api/* and leaves every other path to the static assets.
import * as data from './data.ts'
import { balancesOf, checksum, colour, parseAddress, readBytes, readCapped, safeState, verify, verifyDigest, type SafeState } from './chain.ts'
import { challengeIsOurs, configFor, creationOptions, credentialHash, newChallenge, requestOptions, seal, toBase64Url, unseal, userHandle, verifyAssertion, verifyRegistration, type Config, type Purpose } from './passkeys.ts'
import { CHAIN_NAME, typedLink, typedProof, type ProofKind } from './typed.ts'
import { ask } from './support.ts'
import * as orders from './orders.ts'
import * as partner from './partner.ts'
import { activateIntent, activationIntent, activationProof, apply, applyCheck, DOWNLOAD_REASONS, onboarding, ONBOARDING_EVENTS, operator, OPERATOR, screening, SEAL, sealDeclaration, submit, sync } from './onboarding.ts'

export interface Env { DB: D1Database; ASSETS: Fetcher; SEALED: R2Bucket; ENVIRONMENT: string; CHALLENGE_KEY: string; SEAL_RECIPIENT?: string; INDEXER_URL?: string; INDEXER_TOKEN?: string; SANCTIONS_URL?: string; ORDERBOOK_URL?: string; RPC_URL?: string }

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
  /** The body of a route marked `raw` (milestone 5b: a sealed file), and only there. */
  bytes: Uint8Array
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
  /** Milestone 5: open to an organisation that is not yet verified. Every other signed-in route answers 403 "unverified" there. */
  unverified?: boolean
  /** Milestone 5b: the body is a file sealed in the browser, not JSON, of at most this many bytes. Read after the gates of the row, never before. */
  raw?: number
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
const fail = (status: number, error: string) => json(status, { error })
const LABEL = /^[\p{L}\p{N} ._()-]{1,40}$/u
const NAME = /^[\p{L}\p{N} .'-]{1,60}$/u

const mustBeDeviceBound = (t: { role: data.Role; synced_keys_allowed: number }) => data.needsHardware(t.role, t.synced_keys_allowed)
// What a refusal of the data module answers. Everything not listed is a conflict with the present state: 409.
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, own_request: 403, quarantine: 403, override: 403, institution_only: 403, too_many_orders: 429, invalid: 400, ticket_limit: 429, quote_unavailable: 503, orderbook_unavailable: 503 }
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
  return json(200, { state: 'pending' }) // the colleague who issued the link now confirms it
}

// Takes no input and writes no row: it cannot tell anyone whether an account exists.
async function signinStart(c: Context) {
  return json(200, { options: requestOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'signin', '', c.now)) })
}

// One answer for every failure: unknown passkey, passkey not active, wrong site, stale or replayed challenge.
// More answers exist, and only for a passkey that passed its check: a replaced passkey is told so (it may
// stop its replacement, and opens no session), a passkey of a frozen seat is told who froze the seat and when
// (and opens no session either), a passkey whose 72 hour wait is over becomes active here, and (G4) an active passkey
// of an active seat in an organisation that Ophis froze, or that is closed, is told so and opens no session.
async function signinFinish(c: Context) {
  const denied = fail(401, 'sign_in_failed')
  const id = responseId(c)
  const credential = id ? await data.credentialById(c.env.DB, id, true) : null
  if (!credential) return denied
  const shut = credential.org_state === 'frozen' ? 'org_frozen' : credential.org_state === 'archived' ? 'org_closed' : null
  const replaced = data.hasStopRight(credential, c.now)
  // The passkeys a frozen seat still holds: restored by a stop (active), or suspended by the freeze (no stop right date).
  const frozen = credential.seat_state === 'frozen' && (credential.state === 'active' || (credential.state === 'suspended' && credential.stop_right_until === null))
  if (!frozen && (credential.state === 'suspended' ? !replaced : credential.state === 'active' && credential.seat_state !== 'active')) return denied
  let used = ''
  const counter = await assertion(c, c.body.response, credential, 'signin', '', (challenge) => (used = challenge))
  if (counter === null) return denied
  if (shut) return credential.state === 'active' && credential.seat_state === 'active' ? fail(403, shut) : denied
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
    organisation: { id: s.org_id, name: s.org_name, kind: s.org_kind, quarantineUntil: (s.org_quarantine_until ?? 0) > c.now ? s.org_quarantine_until : null, state: s.org_state },
    seat: { id: s.seat_id, displayName: s.display_name, role: s.role, keys: s.strong_keys, quarantineUntil: c.actor.quarantineUntil },
    session: { id: s.id, endsAt: s.created_at + ABSOLUTE_MS, stepUpUntil: s.step_up_at + STEP_UP_MS },
    // The quarantine alert says which one it is: the seat's own, or the organisation's after an account recovery.
    alerts: ((await data.alertsFor(c.env.DB, c.actor, c.now)) as data.Alert[]).map((alert) => (alert.kind === 'quarantine' && alert.until === s.org_quarantine_until ? { ...alert, detail: 'organisation' } : alert)),
  })
}

async function organisation(c: Context) {
  const view = await data.organisationView(c.env.DB, c.actor, c.now, c.now - IDLE_MS, c.now - ABSOLUTE_MS)
  return json(200, {
    ...view, tickets: await data.openTickets(c.env.DB, c.actor, c.now), currentSessionId: c.session.id,
    // An order's terms in words, made here: the page builds no amount.
    approvals: (await data.openRequests(c.env.DB, c.actor, c.now)).map((a) => (a.kind === 'order' ? { ...a, words: orders.words(JSON.parse(a.value!), null) } : a)),
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

// ---- tickets issued by colleagues, and their confirmation ----

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

// A confirmation is its own passkey check: the challenge covers the ticket and the hash of the pending passkey, so a
// check never serves another ticket or another passkey. Before it, the confirming member makes sure, by a channel both
// trust, that the colleague created that passkey.
async function ticketOpen(c: Context) {
  const ticket = await data.ticketToConfirm(c.env.DB, c.actor, c.params.id ?? '', c.now)
  if (!ticket) return fail(404, 'not_found')
  // Confirming a new member adds a member: blocked in quarantine. A re-enrolment stays open.
  if (ticket.kind === 'invitation' && (c.actor.quarantineUntil ?? 0) > c.now) return fail(403, 'quarantine')
  const hash = toBase64Url(await credentialHash(ticket.credential_id!, ticket.public_key!))
  return { ticket, hash, binding: `${ticket.id}.${hash}` }
}
async function confirmStart(c: Context) {
  const open = await ticketOpen(c)
  return open instanceof Response ? open : json(200, { options: await checkOptions(c, 'confirm', open.binding) })
}
async function confirmFinish(c: Context) {
  const open = await ticketOpen(c)
  if (open instanceof Response) return open
  const check = await ownAssertion(c, 'confirm', open.binding)
  if (!check) return fail(403, 'passkey_rejected')
  const outcome = await data.confirmTicket(c.env.DB, c.actor, open.ticket, { ...check, credentialHash: open.hash, now: c.now })
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
  // Milestone 5: the third kind, the activation of a new organisation by the recovery wallet it names (onboarding.ts).
  const activate = link || recover ? null : await activateIntent(c.env.CHALLENGE_KEY, sealed)
  const intent = link ?? recover ?? activate
  if (!intent) return fail(400, 'intent_invalid')
  if (intent.expiresAt * 1000 <= c.now) return fail(410, 'intent_expired')
  if (!(await data.countProof(c.env.DB, intent.org, c.now))) return fail(429, 'too_many')
  const { signature } = c.body
  if (typeof signature !== 'string' || signature.length > 8194 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)) return fail(400, 'signature_invalid')
  return link ? linkProof(c, link, signature as `0x${string}`) : recover ? recoveryProof(c, recover, signature as `0x${string}`) : activationProof(c, activate!, signature as `0x${string}`)
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
    nonce: intent.nonce, digest: proved.digest, signature, by: proved.by, now: c.now,
  })
  return 'error' in outcome ? refuse(outcome.error) : json(200, outcome)
}

// ---- milestone 4b: last-Owner recovery (recovery.md sections 4 and 5) ----

const ID = /^[0-9a-f]{32}$/
const RECOVER = 'recover-intent' // the label of a recovery intent under the challenge key
const NO_HASH = `0x${'0'.repeat(64)}`
/** What /recover asked for, signed by the server and held nowhere. A cancel names the request's nonce and no passkey. */
interface RecoverIntent {
  kind: ProofKind; org: string; nonce: string; credentialHash: string; issuedAt: number; expiresAt: number; site: string
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
// in, a MAC-signed intent out, which names the passkey by its hash.
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
  const hash = await credentialHash(credential.id, credential.publicKey)
  return json(200, await sealedRecover(c, {
    kind: c.body.override === true ? 'override' : 'replace', org, seat, nonce: `0x${data.randomId()}${data.randomId()}`,
    credentialHash: `0x${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports },
  }))
}
// The same for a cancel by the recovery wallet: an organisation id and the nonce of the request in, an intent out.
// Nothing is read: whether such a request exists is decided when the wallet's signature arrives.
async function recoverCancelIntent(c: Context) {
  const { organisationId: org, nonce } = c.body
  if (typeof org !== 'string' || !ID.test(org) || typeof nonce !== 'string' || !/^0x[0-9a-f]{64}$/.test(nonce)) return fail(400, 'invalid')
  return json(200, await sealedRecover(c, { kind: 'cancel', org, nonce, credentialHash: NO_HASH }))
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
    credentialHash: intent.credentialHash, nonce: intent.nonce, issuedAt: intent.issuedAt, expiresAt: intent.expiresAt,
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
  if (!credential) return denied
  let used = ''
  // Any passkey may try: only the pending one of an open request finds that request, by its seat.
  const counter = await assertion(c, c.body.response, credential, 'continue', '', (challenge) => (used = challenge))
  if (counter === null) return denied
  const r = await data.recoveryRow(c.env.DB, credential.org_id, c.now, 'seat_id', credential.seat_id)
  if (!r) return denied
  if (r.wait_until > c.now) return json(409, { error: 'too_early', until: r.wait_until })
  const endpoints = c.config.chains[r.chainId]
  const proved = endpoints && (await verifyDigest(endpoints, r.chainId, r.digest as `0x${string}`, r.address, r.signature as `0x${string}`))
  const live = endpoints && r.kind === 'safe' ? await safeState(endpoints, r.chainId, r.address) : null
  if (r.kind === 'safe' && !live) return fail(409, 'wallet_unreadable')
  // An override was green at its proof. Unchanged since, it is green now: the snapshot of its approval cannot change while it is in force.
  const same = JSON.stringify(live) === r.owners_snapshot
  // A Safe that differs lapses the request whatever its proof says now (an owner who signed may be the one replaced).
  if (same && !proved) return fail(409, 'wallet_unreadable')
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
  'wallet.link': 'link a wallet', 'anchor.set': 'set the recovery wallet', order: 'prepare an order',
}
// The one table that turns an audit action into words, for the page and the export alike: neither ever shows a
// code. A key with a slash is the action with that detail. A test fails if data.ts writes an action that is not here.
export const EVENTS: Record<string, string> = {
  'organisation.seed': 'Organisation created',
  'credential.store': 'Passkey created, waiting for confirmation',
  'credential.activate': 'Passkey confirmed, now active',
  'credential.activate/wait': 'Passkey active after the 72 hour wait',
  'credential.activate/ophis': 'Passkey confirmed by the issuer, active with no second person: Ophis approved this member with the organisation',
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
  'ticket.confirm': 'New passkey confirmed by the issuer, waiting for a second person',
  'ticket.confirm/wait': 'New passkey confirmed by the issuer, the 72 hour wait started',
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
  'wallet.link/demo': 'Demo wallet linked by the local seed command, with no signature',
  'wallet.unlink': 'Wallet unlinked',
  'anchor.set': 'Recovery wallet set, in force after 72 hours',
  'anchor.set/alone': 'Recovery wallet set by the only key-role member, in force after 72 hours',
  'anchor.cancel': 'Change of recovery wallet cancelled',
  order: 'Order approved: its terms can be signed for 1 hour (a market order) or 24 hours (a limit order)',
  'order.link': 'Link issued to the signing page for an order',
  'order.link/sign': 'Signing link issued for an approved order',
  'order.link/cancel': 'Cancel link issued for an open order',
  'order.withdraw': 'Approved order withdrawn before the wallet signed it: its link no longer works',
  'order.open': 'The signing page read the approved order: its expiry is fixed',
  'order.send': 'Order sent to the orderbook',
  'order.send/eip712': 'Order signed by the wallet and sent to the orderbook',
  'order.send/presign': 'Order sent to the orderbook: it waits for the Safe owners to sign it onchain',
  'order.cancel': 'Order cancelled',
  'order.cancel/key': 'Order cancelled by the signature of the wallet',
  'order.cancel/safe': 'Cancel of the order sent to the Safe, for its owners to sign onchain',
  'order.sanctioned': 'Order refused before it was sent: an address of it is on a loaded sanctions list',
  'recovery.open': 'Account recovery requested by the recovery wallet, 72 hour wait started',
  'recovery.open/override': 'Account recovery requested by the recovery wallet, overriding the Owners, 72 hour wait started',
  'recovery.cancel': 'Account recovery cancelled by an Owner',
  'recovery.cancel/wallet': 'Account recovery cancelled by the recovery wallet',
  'recovery.object': 'Objection to the account recovery, 72 hours added',
  'recovery.complete': 'Account recovery completed: new Owner signed in, the other Owner passkeys suspended, organisation in quarantine for 7 days',
  'recovery.complete/override': 'Account recovery completed, overriding the Owners: new Owner signed in, the other Owners removed, organisation in quarantine for 7 days',
  'recovery.lapse': 'Account recovery lapsed: the recovery wallet changed since the request',
  'recovery.stop': 'Account recovery stopped by a replaced Owner passkey: the new Owner removed, the Owner passkeys restored',
  ...ONBOARDING_EVENTS,
  // Sanctions screening: the one outcome that is said. A row with any other outcome reads as the action alone.
  'kyb.screen/clear': 'Ophis operator: sanctions screening recorded. Result: no match',
  // Milestone 5b: a download of a sealed item says why (the detail of its row is a code of the fixed list).
  ...Object.fromEntries(Object.entries(DOWNLOAD_REASONS).map(([code, words]) => [`sealed.download/${code}`, `${ONBOARDING_EVENTS['sealed.download']}. Reason: ${words}`])),
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
  return csvFile(c, 'ophis-audit-log', lines)
}
/** A CSV file as the browser saves it: the name ends with today's date, and every cell goes through csvCell. */
const csvFile = (c: Context, name: string, lines: unknown[][]) => json(200, { name: `${name}-${new Date(c.now).toISOString().slice(0, 10)}.csv`, csv: lines.map((cells) => `${cells.map(csvCell).join(',')}\r\n`).join('') })

// ---- overview and desk. An institution: its desk (orders.ts), the balances of its linked wallets read on the chain,
// and its statement from its filled orders. A partner: live figures (partner.ts). The approvals counted are real. ----

// The organisation's own orders as the pages show them: the approval row, the terms in words, the state, and once
// filled, the executed amounts and the fee in words (units of each asset).
const ordersOf = async (c: Context) => (await data.orders(c.env.DB, c.actor, c.now)).map(({ terms, approvedAt, status, ...o }) => {
  const units = (atoms: string | null, symbol: string) => (atoms === null ? null : `${orders.decimal(atoms, orders.ASSETS[terms.chainId]?.[symbol as orders.Symbol]?.decimals ?? 18)} ${symbol}`)
  return {
    ...o, terms, words: orders.words(terms, o.validTo), ref: `ORD-${o.id.slice(0, 8)}`, state: orders.stateOf({ ...o, type: terms.type, approvedAt, status }, c.now),
    signUntil: o.state === 'applied' && !o.uid && !status ? orders.signBy({ type: terms.type, approvedAt, validTo: o.validTo }) : null,
    executed: o.sold && status === 'fulfilled' ? { sold: units(o.sold, terms.sell.symbol), bought: units(o.bought, terms.buy.symbol), fee: units(o.fee, terms.sell.symbol) } : null,
  }
})
const REVIEW = 'order-review' // the label of a review under the challenge key
/**
 * An order of the desk. The ticket in, a live quote (from the wallet), the terms out, sealed by the server for 5
 * minutes: that is the review, and nothing is written. With `send` and that sealed review, the terms are filed as a
 * change for two people, exactly as the member reviewed them. Every check is made again inside the commit (judge()).
 */
async function order(c: Context) {
  if (c.session.org_kind !== 'institution') return fail(403, 'institution_only')
  if (c.body.send === true) {
    // Sending needs a fresh passkey check; the review above needs none, so the row of the table carries no `fresh`.
    // Judged here, as the sealed upload does it: the clock and the session were read after the body arrived (api()).
    if (c.now - c.session.step_up_at > STEP_UP_MS) return fail(403, 'step_up_required')
    // A seat id names its organisation: the review of this seat is this organisation's.
    const sealed = (typeof c.body.review === 'string' && (await unseal(c.env.CHALLENGE_KEY, REVIEW, c.body.review))) as { seat: string; at: number; terms: orders.Terms } | null
    if (!sealed || sealed.seat !== c.actor.seatId) return fail(400, 'review_invalid')
    if (c.now - sealed.at > orders.REVIEW_MS) return fail(409, 'review_expired')
    // A member files so many orders an hour and no more.
    if (!(await data.countHour(c.env.DB, `order:${c.actor.seatId}`, c.now, orders.ORDERS_PER_HOUR))) return fail(429, 'order_rate')
    const outcome = await data.change(c.env.DB, c.actor, 'order', data.randomId(), JSON.stringify(sealed.terms), c.now)
    return 'error' in outcome ? refuse(outcome.error) : json(200, outcome)
  }
  const t = orders.ticket(c.body)
  if (typeof t === 'string') return fail(400, t)
  const wallet = (await data.wallets(c.env.DB, c.actor.orgId, c.now)).find((w) => w.id === t.walletId && w.state === 'linked')
  if (!wallet) return refuse('wallet_not_linked')
  if (wallet.chainId !== t.chainId) return refuse('wallet_chain')
  const quoted = await orders.quote(c.env, t, wallet)
  if ('error' in quoted) return json(quoted.error === 'quote_unavailable' ? 503 : 409, quoted)
  const terms = orders.terms(t, wallet, quoted.quoted)
  if (typeof terms === 'string') return fail(400, terms)
  const review = await seal(c.env.CHALLENGE_KEY, REVIEW, { seat: c.actor.seatId, at: c.now, terms })
  return json(200, { terms, words: orders.words(terms, null), review, until: c.now + orders.REVIEW_MS })
}
/** A one-time link to the signing page, for an approved order (sign) or an open one (cancel). Only its SHA-256 is stored. */
async function orderLink(c: Context) {
  const purpose = c.body.purpose === 'cancel' ? 'cancel' : c.body.purpose === 'sign' ? 'sign' : null
  if (!purpose) return fail(400, 'invalid')
  const token = data.randomToken()
  const outcome = await data.orderLink(c.env.DB, c.actor, c.params.id ?? '', purpose, await data.sha256Hex(token), c.now)
  return outcome === 'ok' ? json(200, { link: `${c.config.signOrigin}/sign/#order.${token}` }) : refuse(outcome)
}
/** Withdraws an approved order that the wallet has not signed: one person, as a freeze, since it only tightens. */
async function orderWithdraw(c: Context) {
  const outcome = await data.orderWithdraw(c.env.DB, c.actor, c.params.id ?? '', c.now)
  return outcome === 'ok' ? json(200, { state: 'withdrawn' }) : refuse(outcome)
}
// The signing page's two calls. No session: the link's token is the only key, and its order is read by its hash.
const openedBy = async (c: Context) => {
  const hash = await data.sha256Hex(String(c.body.token)) // a token that is not ours matches no row
  const r = await data.orderByLink(c.env.DB, hash, c.now)
  return r && { ...r, hash }
}
/** What the page shows and has the wallet sign, all built here from the approved terms: the page chooses nothing. */
async function orderPage(c: Context) {
  const r = await openedBy(c)
  if (!r) return fail(404, 'link_invalid')
  const t = r.terms
  let validTo = r.validTo
  // The expiry is fixed when the page first reads a signing link, and stored: every later read signs the same order.
  if (r.purpose === 'sign' && validTo === null) {
    validTo = Math.floor(c.now / 1000) + t.validFor
    if (!(await data.orderOpened(c.env.DB, r, r.hash, validTo, c.now))) return fail(409, 'try_again')
  }
  const built = orders.gpv2(t, validTo!)
  const chain = orders.CHAINS[t.chainId]
  return json(200, {
    purpose: r.purpose, scheme: t.scheme, chainId: t.chainId, wallet: t.wallet, words: orders.words(t, validTo), uid: built.uid, validTo,
    settlement: chain.settlement, relayer: chain.relayer, sellToken: t.sell.token, sellAmount: t.sell.amount,
    typed: t.scheme === 'presign' ? null : r.purpose === 'sign' ? built.typed : orders.cancellation(t.chainId, built.uid).typed,
  })
}
/**
 * The page posts the signature (a key wallet) or nothing (a Safe). Signing: the server builds the order again from the
 * terms and the stored expiry, checks the signature (or posts a presign order from the Safe), the wallet still linked
 * on that chain, the organisation active, and no address of it on a loaded sanctions list; then the orderbook takes it,
 * then one commit records it. Cancelling: the signed cancellation to the orderbook, or a Safe's own transaction.
 */
async function orderSend(c: Context) {
  const r = await openedBy(c)
  if (!r) return fail(404, 'link_invalid')
  const t = r.terms
  if (r.validTo === null) return fail(409, 'not_opened')
  const built = orders.gpv2(t, r.validTo)
  if (r.purpose === 'cancel') {
    if (t.scheme === 'presign') return (await data.orderCancelled(c.env.DB, r, r.hash, 'safe', c.now)) ? json(200, { state: 'asked' }) : fail(409, 'try_again')
    if (!(await orders.signedBy(orders.cancellation(t.chainId, built.uid).hashed, c.body.signature, t.wallet))) return fail(403, 'signature_rejected')
    const done = await orders.cancel(c.env, t.chainId, built.uid, c.body.signature as string)
    if (done !== 'ok') return refuse(done)
    return (await data.orderCancelled(c.env.DB, r, r.hash, 'key', c.now)) ? json(200, { state: 'cancelled' }) : fail(409, 'try_again')
  }
  if (r.walletChain !== t.chainId || r.walletAddress !== t.wallet.toLowerCase()) return refuse('wallet_not_linked') // no linked wallet: both are null
  if (t.scheme === 'eip712' && !(await orders.signedBy(built.hashed, c.body.signature, t.wallet))) return fail(403, 'signature_rejected')
  // A presign order's signature is its owner (the Safe), as the orderbook takes it.
  const signature = t.scheme === 'presign' ? t.wallet.toLowerCase() : (c.body.signature as string)
  const listed = await data.listedOf(c.env.DB, [t.wallet, t.sell.token, t.buy.token])
  if (listed) {
    await data.orderListed(c.env.DB, r, r.hash, listed === t.wallet.toLowerCase() ? 'wallet' : listed === t.sell.token.toLowerCase() ? 'sell' : 'buy', c.now)
    return fail(403, 'sanctioned_address')
  }
  const posted = await orders.post(c.env, t, built, signature)
  if (posted !== 'ok') return refuse(posted)
  const status = t.scheme === 'presign' ? 'presignaturePending' : 'open'
  const outcome = await data.orderSent(c.env.DB, r, { uid: built.uid, signature, status }, c.now)
  return outcome === 'ok' ? json(200, { state: status, uid: built.uid }) : refuse(outcome)
}
/** Reads the orderbook's state of sent orders that may still change: of one organisation (the desk, at most 10) or of all (the daily run). */
async function refresh(env: Env, orgId: string | null, now: number, limit: number) {
  const read = []
  for (const o of await data.openOrders(env.DB, orgId, limit)) {
    const state = await orders.status(env, o.chainId, o.uid, o.sellToken)
    if (state) read.push({ ...o, ...state })
  }
  await data.orderStates(env.DB, read, now)
}
const waiting = async (c: Context) => (await data.openRequests(c.env.DB, c.actor, c.now)).filter((request) => !request.mine).length
async function overview(c: Context) {
  const kind = c.session.org_kind
  // A partner: its real figures (partner.ts), or the plain state that says why there are none. Never an example.
  if (kind === 'partner') return json(200, { kind, waiting: await waiting(c), figures: await partner.figures(c.env, c.actor.orgId, c.now) })
  const list = await ordersOf(c)
  return json(200, { kind, waiting: await waiting(c), asOf: new Date(c.now).toISOString(), balances: await balances(c), months: await statement(c), orders: list.slice(0, 8), open: list.filter((o) => o.state === 'Open').length })
}
// ponytail: a cache of this isolate, 60 seconds, keyed by the organisation and its wallets. A D1 row would hold across isolates.
const BALANCE_CACHE = new Map<string, { at: number; value: Awaited<ReturnType<typeof readBalances>> }>()
const BALANCE_MS = 60_000
const BALANCE_WALLETS = 10 // the wallets linked first: 10 of 5 assets is 50 calls, whose answer fits the 16 KB of an RPC answer
/** The balances of the organisation's linked wallets on the desk chains, in the assets of each chain: read briefly cached. */
async function balances(c: Context) {
  const wallets = (await data.wallets(c.env.DB, c.actor.orgId, c.now)).filter((w) => w.state === 'linked' && Object.hasOwn(orders.CHAINS, w.chainId))
  const key = `${c.actor.orgId} ${wallets.slice(0, BALANCE_WALLETS).map((w) => `${w.id}:${w.chainId}:${w.address}`).join()}`
  const seen = BALANCE_CACHE.get(key)
  if (seen && c.now - seen.at < BALANCE_MS) return { ...seen.value, leftOut: wallets.length - seen.value.wallets.length }
  for (const [k, v] of BALANCE_CACHE) if (c.now - v.at >= BALANCE_MS) BALANCE_CACHE.delete(k)
  const value = await readBalances(c, wallets.slice(0, BALANCE_WALLETS), c.now)
  BALANCE_CACHE.set(key, { at: c.now, value })
  return { ...value, leftOut: wallets.length - value.wallets.length }
}
/** One aggregate3 per chain, on that chain's two endpoints (locally, RPC_URL names a stand-in on this machine). */
async function readBalances(c: Context, wallets: Awaited<ReturnType<typeof data.wallets>>, at: number) {
  const local = orders.standIn(c.env, c.env.RPC_URL)
  const chains = [...new Set(wallets.map((w) => w.chainId))]
  const read = new Map(await Promise.all(chains.map(async (chainId) => {
    const assets = Object.entries(orders.ASSETS[chainId]) as [orders.Symbol, orders.Asset][]
    const mine = wallets.filter((w) => w.chainId === chainId)
    const endpoints = local ? ([`${local}/${chainId}/a`, `${local}/${chainId}/b`] as const) : c.config.chains[chainId]
    const got = await balancesOf(endpoints, chainId, mine.flatMap((w) => assets.map(([, a]) => [w.address, a.token] as [string, string])))
    return [chainId, { assets, got }] as const
  })))
  return {
    readAt: new Date(at).toISOString(),
    wallets: wallets.map((w) => {
      const { assets, got } = read.get(w.chainId)!
      const first = wallets.filter((x) => x.chainId === w.chainId).indexOf(w) * assets.length
      return {
        wallet: w.label, address: checksum(w.address), chain: CHAIN_NAME[w.chainId], read: got !== null,
        rows: assets.map(([symbol, a], i) => ({ asset: symbol, token: a.token, balance: got?.[first + i] == null ? null : orders.decimal(got[first + i]!, a.decimals) })),
      }
    }),
  }
}
/** The monthly statement: the filled orders of the last 12 months, by the month they were sent (UTC) and the asset sold. */
async function statement(c: Context) {
  const months = new Map<string, { month: string; asset: string; orders: number; volume: bigint; fee: bigint; unreported: number; decimals: number }>()
  for (const o of await data.filledOrders(c.env.DB, c.actor.orgId, c.now - 365 * 86_400_000)) {
    const decimals = orders.ASSETS[o.chainId]?.[o.symbol as orders.Symbol]?.decimals
    if (decimals === undefined) continue // no asset this server lists: never an amount in units it cannot name
    const key = `${new Date(o.sentAt).toISOString().slice(0, 7)} ${o.symbol}`
    const m = months.get(key) ?? { month: key.slice(0, 7), asset: o.symbol, orders: 0, volume: 0n, fee: 0n, unreported: 0, decimals }
    months.set(key, { ...m, orders: m.orders + 1, volume: m.volume + BigInt(o.sold), fee: m.fee + BigInt(o.fee ?? 0), unreported: m.unreported + (o.fee === null ? 1 : 0) })
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month) || a.asset.localeCompare(b.asset))
    .map((m) => ({ month: m.month, asset: m.asset, orders: m.orders, volume: orders.decimal(m.volume, m.decimals), fee: orders.decimal(m.fee, m.decimals), unreported: m.unreported }))
}
async function desk(c: Context) {
  if (c.session.org_kind !== 'institution') return fail(403, 'institution_only')
  await refresh(c.env, c.actor.orgId, c.now, 10)
  const wallets = (await data.wallets(c.env.DB, c.actor.orgId, c.now)).filter((w) => w.state === 'linked' && Object.hasOwn(orders.CHAINS, w.chainId))
  return json(200, {
    chains: Object.keys(orders.CHAINS).map((id) => ({ id: Number(id), name: CHAIN_NAME[Number(id)] })),
    assets: assetRows(), validity: orders.VALIDITY, slippage: orders.SLIPPAGE, maxOpen: orders.MAX_OPEN_ORDERS,
    mayPrepare: (orders.PREPARERS as readonly string[]).includes(c.actor.role), maySign: (orders.SIGNERS as readonly string[]).includes(c.actor.role), orders: await ordersOf(c),
    wallets: wallets.map((w) => ({ id: w.id, label: w.label, address: checksum(w.address), chainId: w.chainId, chain: CHAIN_NAME[w.chainId], scheme: w.kind === 'safe' ? 'presign' : 'eip712' })),
  })
}
/** The permitted assets: one row per asset and chain, with its token and the most one order sells. */
const assetRows = () => Object.entries(orders.ASSETS).flatMap(([id, assets]) => Object.entries(assets).map(([symbol, a]) => ({
  chainId: Number(id), chain: CHAIN_NAME[Number(id)], symbol, token: a!.token, decimals: a!.decimals, cap: orders.decimal(orders.capOf(symbol as orders.Symbol, a!.decimals), a!.decimals),
})))

// Every "Export CSV" button of Overview and Desk. The tables follow the kind of the organisation; every row says
// source = live. An institution: its orders (every term, the state, what the orderbook executed), the balances of its
// linked wallets, its statement and the permitted assets. A partner: its figures from a fresh read of the indexer; no read, no file.
const utc = (time: number | null) => (time === null ? '' : new Date(time).toISOString())
const INSTITUTION: Record<string, [head: string[], rows: (c: Context) => Promise<unknown[][]>]> = {
  orders: [['Order', 'Prepared at', 'Prepared by', 'Type', 'Chain', 'Wallet', 'Wallet address', 'Signing', 'Sell', 'Sell token', 'Amount sold', 'Buy', 'Buy token', 'Least amount bought',
    'Live quote', 'Slippage (bps)', 'Limit price', 'Valid after signing (s)', 'Valid until', 'App data hash', 'Status', 'Decided by', 'Decided at', 'Signing link by', 'Signing link at', 'Order id', 'Sent at',
    'Sold', 'Bought', 'Fee', 'Transaction'],
  async (c) => (await ordersOf(c)).map((o) => {
    // An asset delisted since: 18 decimals, as its words say.
    const [s, b] = [o.terms.sell, o.terms.buy].map((x) => orders.ASSETS[o.terms.chainId]?.[x.symbol]?.decimals ?? 18)
    return [o.ref, utc(o.at), o.preparer, o.terms.type, CHAIN_NAME[o.terms.chainId], o.terms.label, o.terms.wallet, o.terms.scheme, o.terms.sell.symbol, o.terms.sell.token, orders.decimal(o.terms.sell.amount, s),
      o.terms.buy.symbol, o.terms.buy.token, orders.decimal(o.terms.buy.minimum, b), orders.decimal(o.terms.quoted, b), o.terms.slippageBips ?? '', o.terms.limitPrice ?? '', o.terms.validFor,
      o.validTo === null ? '' : utc(o.validTo * 1000), o.terms.appDataHash, o.state, o.decidedBy ?? '', utc(o.decidedAt), o.linkBy ?? '', utc(o.linkAt), o.uid ?? '', utc(o.sentAt),
      o.executed?.sold ?? '', o.executed?.bought ?? '', o.executed?.fee ?? '', o.tx ?? '']
  })],
  balances: [['Wallet', 'Address', 'Chain', 'Asset', 'Token', 'Balance', 'Read at'],
    async (c) => { const b = await balances(c); return b.wallets.flatMap((w) => w.rows.map((r) => [w.wallet, w.address, w.chain, r.asset, r.token, r.balance ?? 'not read', b.readAt])) }],
  statement: [['Month', 'Asset sold', 'Filled orders', 'Volume sold', 'Fees', 'Orders with no fee reported'], async (c) => (await statement(c)).map((m) => [m.month, m.asset, m.orders, m.volume, m.fee, m.unreported])],
  assets: [['Chain', 'Asset', 'Token', 'Decimals', 'Most per order'], async () => assetRows().map((a) => [a.chain, a.symbol, a.token, a.decimals, a.cap])],
}
async function tableExport(c: Context) {
  const table = c.params.id ?? ''
  if (c.session.org_kind !== 'partner') {
    if (!Object.hasOwn(INSTITUTION, table)) return fail(404, 'not_found')
    const [head, rows] = INSTITUTION[table]
    return csvFile(c, `ophis-${table}`, [[...head, 'source'], ...(await rows(c)).map((cells) => [...cells, 'live'])])
  }
  if (!Object.hasOwn(partner.tables({ state: 'live', asOf: '', leftOut: 0, lists: [], wallets: [] }), table)) return fail(404, 'not_found')
  const figures = await partner.figures(c.env, c.actor.orgId, c.now)
  if (figures.state !== 'live') return fail(figures.state === 'figures_unavailable' ? 503 : figures.state === 'figures_rate' ? 429 : 409, figures.state)
  const [head, rows] = partner.tables(figures)[table]
  return csvFile(c, `ophis-partner-${table}`, [[...head, 'source'], ...rows.map((cells) => [...cells, 'live'])])
}

const ANY = data.ROLES
const MANAGERS: readonly data.Role[] = ['owner', 'admin']
const READERS: readonly data.Role[] = ['owner', 'compliance', 'viewer']
const SELF = 'Sign in, pass a passkey check, sign out'
const ADD = 'Add a passkey to the own seat'
const CONFIRM = 'Confirm a colleague\'s new passkey with a passkey check'
// The route table, which is the role table. A state change is a POST. tests/worker.test.ts fails if a route is
// missing from its copy of this table, or has no isolation case.
export const routes: Route[] = [
  { method: 'POST', path: '/api/enrol/start', roles: 'public', handler: enrolStart },
  { method: 'POST', path: '/api/enrol/finish', roles: 'public', handler: enrolFinish },
  { method: 'POST', path: '/api/signin/start', roles: 'public', handler: signinStart },
  { method: 'POST', path: '/api/signin/finish', roles: 'public', handler: signinFinish },
  { method: 'GET', path: '/api/me', roles: ANY, unverified: true, can: SELF, handler: me },
  { method: 'GET', path: '/api/org', roles: ANY, unverified: true, can: 'See the own seat, its passkeys and sessions (Owner and Admin: those of every member)', handler: organisation },
  { method: 'POST', path: '/api/sessions/:id/revoke', roles: ANY, unverified: true, can: 'End a session of the own seat (Owner and Admin: of any member)', handler: revoke },
  { method: 'POST', path: '/api/signout', roles: ANY, unverified: true, can: SELF, handler: signout },
  { method: 'POST', path: '/api/stepup/start', roles: ANY, unverified: true, can: SELF, handler: stepupStart },
  { method: 'POST', path: '/api/stepup/finish', roles: ANY, unverified: true, can: SELF, handler: stepupFinish },
  { method: 'POST', path: '/api/passkeys/start', roles: ANY, fresh: true, unverified: true, can: ADD, handler: passkeyStart },
  { method: 'POST', path: '/api/passkeys/finish', roles: ANY, fresh: true, unverified: true, can: ADD, handler: passkeyFinish },
  { method: 'POST', path: '/api/passkeys/:id/revoke', roles: ANY, fresh: true, twoKeys: true, unverified: true, can: 'Revoke a passkey of the own seat, never the last (Owner and Admin: also of a member at or below their role)', handler: passkeyRevoke },
  { method: 'POST', path: '/api/tickets', roles: MANAGERS, fresh: true, twoKeys: true, unverified: true, can: 'Invite a member, or re-enrol one who lost every passkey', handler: ticketIssue },
  { method: 'POST', path: '/api/tickets/:id/confirm/start', roles: data.KEY_ROLES, twoKeys: true, unverified: true, can: CONFIRM, handler: confirmStart },
  { method: 'POST', path: '/api/tickets/:id/confirm', roles: data.KEY_ROLES, twoKeys: true, unverified: true, can: CONFIRM, handler: confirmFinish },
  { method: 'POST', path: '/api/tickets/:id/cancel', roles: ['owner'], fresh: true, twoKeys: true, unverified: true, can: 'Cancel an enrolment that waits', handler: ticketCancel },
  { method: 'POST', path: '/api/stop/start', roles: 'public', handler: stopStart },
  { method: 'POST', path: '/api/stop/finish', roles: 'public', handler: stopFinish },
  { method: 'POST', path: '/api/members/:id/freeze', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, can: 'Freeze a seat at once, in an emergency (Admin: a seat at or below Admin)', handler: (c) => change(c, 'seat.freeze') },
  { method: 'POST', path: '/api/members/:id/unfreeze', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, second: 'seat.unfreeze', can: 'Ask to unfreeze a seat' },
  { method: 'POST', path: '/api/members/:id/role', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, second: 'seat.role', can: 'Ask to change a member\'s role, never above the own role' },
  { method: 'POST', path: '/api/members/:id/remove', roles: MANAGERS, fresh: true, twoKeys: true, settled: true, second: 'seat.remove', can: 'Ask to remove a member (an invited seat nobody enrolled on: removed at once)' },
  { method: 'POST', path: '/api/policy', roles: ['owner'], fresh: true, twoKeys: true, settled: true, second: 'policy.synced_keys', can: 'Ask to change the passkey rule for key roles' },
  { method: 'POST', path: '/api/approvals/:id/approve', roles: data.KEY_ROLES, fresh: true, twoKeys: true, settled: true, can: 'Approve a colleague\'s request as the second person', handler: decide('approve') },
  { method: 'POST', path: '/api/approvals/:id/reject', roles: data.KEY_ROLES, fresh: true, twoKeys: true, can: 'Reject a colleague\'s request', handler: decide('reject') },
  { method: 'POST', path: '/api/approvals/:id/cancel', roles: orders.PREPARERS, can: 'Cancel the own request', handler: decide('cancel') },
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
  { method: 'GET', path: '/api/screening', roles: READERS, can: 'See the sanctions screening Ophis recorded for the organisation, and the address lists its linked wallets are compared with', handler: screening },
  { method: 'GET', path: '/api/overview', roles: ANY, can: 'See the overview of the organisation (an institution: the balances of its linked wallets, its orders and its statement; a partner: its figures from the Ophis rebate service)', handler: overview },
  { method: 'GET', path: '/api/desk', roles: ANY, can: 'See the desk of an institution: permitted assets, orders and their records', handler: desk },
  { method: 'GET', path: '/api/export/:id', roles: ANY, can: 'Export a table of the overview or the desk as CSV', handler: tableExport },
  { method: 'POST', path: '/api/desk/orders', roles: orders.PREPARERS, settled: true, can: 'Prepare an order on the desk, which a second person approves before the wallet signs it', handler: order },
  { method: 'POST', path: '/api/desk/orders/:id/link', roles: orders.SIGNERS, fresh: true, settled: true, can: 'Give the wallet the link to sign an approved order, or to cancel an open one', handler: orderLink },
  { method: 'POST', path: '/api/desk/orders/:id/withdraw', roles: orders.SIGNERS, fresh: true, settled: true, can: 'Withdraw an approved order before the wallet signs it, at once', handler: orderWithdraw },
  // The real desk: the signing page's two calls, on the signing host. The link's one-time token is the only key.
  { method: 'POST', path: '/api/order', roles: 'public', sign: true, handler: orderPage },
  { method: 'POST', path: '/api/order/send', roles: 'public', sign: true, handler: orderSend },
  { method: 'POST', path: '/api/support/ask', roles: ANY, unverified: true, can: 'Ask Support a question, which is matched to the fixed help texts', handler: ask },
  // Milestone 5 (onboarding.ts). The operator's routes are not here: they have their own hostname and no role.
  { method: 'POST', path: '/api/apply', roles: 'public', handler: apply },
  { method: 'POST', path: '/api/apply/check', roles: 'public', handler: applyCheck },
  { method: 'GET', path: '/api/onboarding', roles: ['owner', 'compliance'], unverified: true, can: 'See the onboarding steps, the review status and the KYB record', handler: onboarding },
  { method: 'POST', path: '/api/onboarding/wallet', roles: ['owner'], fresh: true, twoKeys: true, unverified: true, can: 'Name the recovery wallet of a new organisation, which the wallet then confirms with a signature', handler: activationIntent },
  { method: 'POST', path: '/api/onboarding/submit', roles: ['owner'], fresh: true, twoKeys: true, unverified: true, can: 'Submit a new organisation for review', handler: submit },
  // Milestone 5b: the one route whose body is not JSON: the signed declaration, sealed in the browser.
  { method: 'POST', path: '/api/onboarding/declaration', roles: ['owner'], fresh: true, twoKeys: true, unverified: true, raw: SEAL.maxBytes, can: 'Upload the signed declaration of a new organisation, sealed in the browser', handler: sealDeclaration },
]
// "What each role can do": the rows of the table above that a session can reach. Routes that share a sentence are one row.
// An order is the one two-person change with a handler of its own (the estimate first): it carries both marks here.
const rights = [...new Map(routes.flatMap((r) => (r.can ? [[r.can, { can: r.can, roles: r.roles, fresh: Boolean(r.fresh) || r.handler === order, second: Boolean(r.second) || r.handler === order }] as const] : []))).values()]
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
  if (route.method === 'POST' && request.headers.get('origin') !== (signing ? config.signOrigin : config.origin)) return fail(403, 'bad_origin')
  if (route.method === 'POST' && !route.raw) {
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
    // Milestone 5: the organisation's state, read with the session, before anything else is decided. Not yet verified:
    // the rows marked `unverified` and no other. Frozen by the operator, or archived: nothing but the sign-out.
    const state = session.org_state
    const closed = state === 'active' ? null : state === 'unverified' ? (route.unverified ? null : 'unverified') : route.handler === signout ? null : state === 'frozen' ? 'org_frozen' : 'org_closed'
    if (closed) return fail(403, closed)
    // The role table, enforced here for every route: the role, then the gates of the row.
    if (!route.roles.includes(session.role)) return fail(403, 'forbidden')
    if (route.twoKeys && session.strong_keys < 2) return fail(403, 'second_key_required')
    if (route.settled && context.actor.quarantineUntil) return fail(403, 'quarantine')
    if (route.fresh && now - session.step_up_at > STEP_UP_MS) return fail(403, 'step_up_required')
  }
  // Milestone 5b: a sealed file is megabytes, so it is read only now, for a caller who passed every gate of the row,
  // and never for anybody else. The content type is no "simple" one: a cross-site page cannot send it without a
  // preflight, which is never granted. The clock is read again once the body has arrived, and the session with it.
  if (route.raw) {
    if (!/^application\/octet-stream\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return fail(415, 'binary_only')
    const bytes = await readBytes(request.body, route.raw)
    if (!bytes) return fail(413, 'too_large')
    context.bytes = bytes
    context.now = clock()
    const still = await sessionOf(request, env, context.now)
    if (!still) return fail(401, 'signed_out')
    if (route.fresh && context.now - still.step_up_at > STEP_UP_MS) return fail(403, 'step_up_required') // review of 5b: a slow body does not stretch the 5 minutes
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
  const asset = await env.ASSETS.fetch(pathname === '/recover' || pathname === '/apply' ? new Request(new URL('/', request.url), request) : request)
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
    // Milestone 5: the operator's API, on a third hostname (onboarding.ts). It serves no page.
    if (origin === OPERATOR[env.ENVIRONMENT]) return await operator(request, env, now, config, HEADERS)
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

/**
 * M10, the daily run (one cron in wrangler.jsonc): the read of the OFAC list file. An error is logged in fixed words,
 * no address and no name, and the run answers unavailable: the loaded lists still stand. `now` is injectable, as for handle().
 */
export async function daily(env: Env, now: number) {
  const read = await sync(env, now).catch(() => (console.error('daily run: the read of the list file failed'), { outcome: 'unavailable' as const }))
  // The real desk: the state of 20 sent orders, the least recently read first (the desk reads its own 10 at each view).
  await refresh(env, null, now, 20).catch(() => console.error('daily run: the read of the orderbook failed'))
  return read
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_controller, env, context) => context.waitUntil(daily(env, Date.now())),
} satisfies ExportedHandler<Env>
