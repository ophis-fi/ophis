// Worker entry: answers /api/* and leaves every other path to the static assets.
import * as data from './data.ts'
import { challengeIsOurs, configFor, creationOptions, newChallenge, requestOptions, userHandle, verifyAssertion, verifyRegistration, type Config } from './passkeys.ts'

export interface Env { DB: D1Database; ASSETS: Fetcher; ENVIRONMENT: string; CHALLENGE_KEY: string }

const IDLE_MS = 15 * 60_000
const ABSOLUTE_MS = 12 * 60 * 60_000
const TOUCH_MS = 60_000
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
  session: data.Session; actor: data.Actor
}
interface Route { method: 'GET' | 'POST'; path: string; session: boolean; handler: (c: Context) => Promise<Response> }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers })
const fail = (status: number, error: string) => json(status, { error })
const KEY_ROLES = ['owner', 'admin', 'approver', 'compliance']

// Owners: device-bound keys only, no exception. Other key roles: device-bound unless the organisation allowed synced keys.
const mustBeDeviceBound = (t: data.Ticket) => t.role === 'owner' || (KEY_ROLES.includes(t.role) && t.synced_keys_allowed !== 1)

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
    organisation: ticket.org_name, member: ticket.display_name, role: ticket.role, deviceBound,
    options: creationOptions(c.config, challenge, { id: ticket.seat_id, name: ticket.display_name }, deviceBound),
  })
}

async function enrolFinish(c: Context) {
  const ticket = await ticketOf(c)
  if (!ticket) return fail(404, 'ticket_invalid')
  const label = typeof c.body.label === 'string' ? c.body.label.trim() : ''
  if (!/^[\p{L}\p{N} ._()-]{1,40}$/u.test(label)) return fail(400, 'label_invalid')
  let credential
  try {
    credential = await verifyRegistration(c.config, c.body.response, (challenge) => challengeIsOurs(c.env.CHALLENGE_KEY, 'enrol', ticket.id, challenge, c.now))
  } catch {
    return fail(400, 'passkey_rejected')
  }
  if (mustBeDeviceBound(ticket) && !credential.deviceBound) return fail(400, 'device_bound_required')
  try {
    await data.storePendingCredential(c.env.DB, ticket, credential, label, c.now)
  } catch {
    return fail(409, 'not_stored')
  }
  return json(200, { state: 'pending' })
}

// Takes no input and writes no row: it cannot tell anyone whether an account exists.
async function signinStart(c: Context) {
  return json(200, { options: requestOptions(c.config, await newChallenge(c.env.CHALLENGE_KEY, 'signin', '', c.now)) })
}

// One answer for every failure: unknown passkey, passkey not active, wrong site, stale or replayed challenge.
async function signinFinish(c: Context) {
  const denied = fail(401, 'sign_in_failed')
  const response = c.body.response as { id?: unknown; response?: { userHandle?: unknown } } | undefined
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') return denied
  const credential = await data.credentialForSignIn(c.env.DB, response.id)
  if (!credential) return denied
  let used = ''
  let counter
  try {
    counter = await verifyAssertion(c.config, response, credential, (challenge) => {
      used = challenge
      return challengeIsOurs(c.env.CHALLENGE_KEY, 'signin', '', challenge, c.now)
    })
  } catch {
    return denied
  }
  if (response.response?.userHandle !== userHandle(credential.seat_id)) return denied
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

async function me(c: Context) {
  const s = c.session
  return json(200, {
    organisation: { id: s.org_id, name: s.org_name, kind: s.org_kind },
    seat: { id: s.seat_id, displayName: s.display_name, role: s.role },
    session: { id: s.id, endsAt: s.created_at + ABSOLUTE_MS },
  })
}

async function organisation(c: Context) {
  const view = await data.organisationView(c.env.DB, c.actor, c.now - IDLE_MS, c.now - ABSOLUTE_MS)
  return json(200, { ...view, currentSessionId: c.session.id })
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
  const session = await data.sessionByToken(env.DB, await data.sha256Hex(token))
  if (!session) return null
  // Both limits are the server's: 15 minutes idle, 12 hours from sign-in.
  if (now - session.last_seen_at > IDLE_MS || now - session.created_at > ABSOLUTE_MS) return null
  // ponytail: the idle clock is written at most once a minute to spare D1 writes, so a session can
  // end up to 60 s early, never late. Write on every request if that minute ever matters.
  if (now - session.last_seen_at >= TOUCH_MS) await data.touchSession(env.DB, { orgId: session.org_id, sessionId: session.id }, now)
  return session
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
    context.actor = { orgId: session.org_id, seatId: session.seat_id, sessionId: session.id, role: session.role, country: cf?.country ?? null, asn: cf?.asn ?? null }
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
