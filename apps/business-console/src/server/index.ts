// Worker entry: answers /api/* and leaves every other path to the static assets.
import * as data from './data.ts'
import { challengeIsOurs, configFor, creationOptions, credentialHash, newChallenge, phraseFor, requestOptions, toBase64Url, userHandle, verifyAssertion, verifyRegistration, type Config, type Purpose } from './passkeys.ts'
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

interface Context {
  request: Request; env: Env; now: number; config: Config
  body: Record<string, unknown>; params: Record<string, string | undefined>
  /** Set on routes marked session: true, and only there. */
  session: data.Session & { token_hash: string }; actor: data.Actor
}
// fresh: a passkey check in the last 5 minutes (step-up). twoKeys: the seat holds two active passkeys, device-bound
// ones for an Owner; until then it can sign in, pass a check and add its second key, and nothing else that is sensitive.
interface Route { method: 'GET' | 'POST'; path: string; session: boolean; fresh?: boolean; twoKeys?: boolean; handler: (c: Context) => Promise<Response> }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
const fail = (status: number, error: string) => json(status, { error })
const LABEL = /^[\p{L}\p{N} ._()-]{1,40}$/u
const NAME = /^[\p{L}\p{N} .'-]{1,60}$/u

// Owners: device-bound keys only, no exception. Other key roles: device-bound unless the organisation allowed synced keys.
const mustBeDeviceBound = (t: { role: data.Role; synced_keys_allowed: number }) => t.role === 'owner' || (data.KEY_ROLES.includes(t.role) && t.synced_keys_allowed !== 1)

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
  if (!(await data.storePendingCredential(c.env.DB, ticket, credential, label, c.now).catch(() => false))) return fail(409, 'not_stored')
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
// Two more answers exist, and only for a passkey that passed its check: a replaced passkey is told so (it may
// stop its replacement, and opens no session), and a passkey whose 72 hour wait is over becomes active here.
async function signinFinish(c: Context) {
  const denied = fail(401, 'sign_in_failed')
  const id = responseId(c)
  const credential = id ? await data.credentialById(c.env.DB, id) : null
  if (!credential) return denied
  const replaced = data.hasStopRight(credential, c.now)
  if (credential.state === 'suspended' ? !replaced : credential.state === 'active' && credential.seat_state !== 'active') return denied
  let used = ''
  const counter = await assertion(c, c.body.response, credential, 'signin', '', (challenge) => (used = challenge))
  if (counter === null) return denied
  if (replaced) return json(403, { error: 'passkey_replaced', until: credential.stop_right_until })
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
    organisation: { id: s.org_id, name: s.org_name, kind: s.org_kind },
    seat: { id: s.seat_id, displayName: s.display_name, role: s.role, keys: s.strong_keys, quarantineUntil: c.actor.quarantineUntil },
    session: { id: s.id, endsAt: s.created_at + ABSOLUTE_MS, stepUpUntil: s.step_up_at + STEP_UP_MS },
    alerts: await data.alertsFor(c.env.DB, c.actor, c.now),
  })
}

async function organisation(c: Context) {
  const view = await data.organisationView(c.env.DB, c.actor, c.now - IDLE_MS, c.now - ABSOLUTE_MS)
  return json(200, { ...view, tickets: await data.openTickets(c.env.DB, c.actor, c.now), currentSessionId: c.session.id })
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
  } catch {
    // the same passkey twice: the credential id is the primary key
  }
  return fail(409, 'not_stored')
}
async function passkeyRevoke(c: Context) {
  const outcome = await data.revokeCredential(c.env.DB, c.actor, c.params.id ?? '', c.now)
  return outcome === 'ok' ? json(200, { ok: true }) : fail(outcome === 'not_found' ? 404 : outcome === 'last_passkey' ? 409 : 403, outcome)
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
  if (issued.error) return fail(issued.error === 'not_found' ? 404 : issued.error === 'ticket_limit' ? 429 : 403, issued.error)
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
  if (c.actor.role !== 'owner') return fail(403, 'forbidden')
  return (await data.cancelTicket(c.env.DB, c.actor, c.params.id ?? '', c.now)) ? json(200, { ok: true }) : fail(404, 'not_found')
}

// The route table. A state change is a POST. tests/worker.test.ts fails if a route has no isolation case.
export const routes: Route[] = [
  { method: 'POST', path: '/api/enrol/start', session: false, handler: enrolStart },
  { method: 'POST', path: '/api/enrol/finish', session: false, handler: enrolFinish },
  { method: 'POST', path: '/api/signin/start', session: false, handler: signinStart },
  { method: 'POST', path: '/api/signin/finish', session: false, handler: signinFinish },
  { method: 'GET', path: '/api/me', session: true, handler: me },
  { method: 'GET', path: '/api/org', session: true, handler: organisation },
  { method: 'POST', path: '/api/sessions/:id/revoke', session: true, handler: revoke },
  { method: 'POST', path: '/api/signout', session: true, handler: signout },
  { method: 'POST', path: '/api/stepup/start', session: true, handler: stepupStart },
  { method: 'POST', path: '/api/stepup/finish', session: true, handler: stepupFinish },
  { method: 'POST', path: '/api/passkeys/start', session: true, fresh: true, handler: passkeyStart },
  { method: 'POST', path: '/api/passkeys/finish', session: true, fresh: true, handler: passkeyFinish },
  { method: 'POST', path: '/api/passkeys/:id/revoke', session: true, fresh: true, twoKeys: true, handler: passkeyRevoke },
  { method: 'POST', path: '/api/tickets', session: true, fresh: true, twoKeys: true, handler: ticketIssue },
  { method: 'POST', path: '/api/tickets/:id/confirm/start', session: true, twoKeys: true, handler: confirmStart },
  { method: 'POST', path: '/api/tickets/:id/confirm', session: true, twoKeys: true, handler: confirmFinish },
  { method: 'POST', path: '/api/tickets/:id/cancel', session: true, fresh: true, twoKeys: true, handler: ticketCancel },
  { method: 'POST', path: '/api/stop/start', session: false, handler: stopStart },
  { method: 'POST', path: '/api/stop/finish', session: false, handler: stopFinish },
]
const patterns = routes.map((route) => new URLPattern({ pathname: route.path }))

async function readBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

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

async function api(request: Request, env: Env, clock: () => number): Promise<Response> {
  const config = configFor(env.ENVIRONMENT)
  // Every API route, GET included. A sibling *.ophis.fi host is same-site, so same-site is not enough.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return fail(403, 'cross_site')
  const { pathname } = new URL(request.url)
  const index = routes.findIndex((route, i) => route.method === request.method && patterns[i].test({ pathname }))
  if (index < 0) return fail(404, 'not_found')
  const route = routes[index]
  let body: Record<string, unknown> = {}
  if (route.method === 'POST') {
    if (request.headers.get('origin') !== config.origin) return fail(403, 'bad_origin')
    if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return fail(415, 'json_only')
    const text = await readBody(request)
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
  if (route.session) {
    const session = await sessionOf(request, env, now)
    if (!session) return fail(401, 'signed_out')
    const cf = (request as Request<unknown, IncomingRequestCfProperties>).cf
    context.session = session
    // The organisation of every later query comes from here, never from the request.
    context.actor = {
      orgId: session.org_id, seatId: session.seat_id, sessionId: session.id, role: session.role,
      quarantineUntil: (session.quarantine_until ?? 0) > now ? session.quarantine_until : null, country: cf?.country ?? null, asn: cf?.asn ?? null,
    }
    if (route.twoKeys && session.strong_keys < 2) return fail(403, 'second_key_required')
    if (route.fresh && now - session.step_up_at > STEP_UP_MS) return fail(403, 'step_up_required')
  }
  return route.handler(context)
}

/** `now` is injectable so that tests own the clock. */
export async function handle(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
  let response: Response
  try {
    response = await api(request, env, now)
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
