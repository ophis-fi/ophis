// Company sign-in (owner decision of 2026-11-11): OpenID Connect, authorization code with PKCE, state and nonce.
// Passkeys stay the only way to sign in. A company account at Microsoft or Google proves WHO a new passkey belongs
// to, once, when a member joins or is re-enrolled. This file holds the protocol and nothing else: the constants per
// environment, the address the browser is sent to, the exchange of the code, and the full check of the ID token.
// It reads no row and writes none; index.ts decides what a verified identity may do.
import { readCapped } from './chain.ts'
import { fromBase64Url, toBase64Url } from './passkeys.ts'

export type Provider = 'microsoft' | 'google'
export const PROVIDERS: readonly Provider[] = ['microsoft', 'google']
/** issuer: the exact `iss`; for Microsoft the text {tenantid} stands for the token's own `tid` (one issuer per tenant). */
interface Idp { authorize: string; token: string; keys: string; issuer: string; clientId: string }

// Constants per environment, like those of passkeys.ts, never read from a request. Client secrets are Worker secrets
// (MICROSOFT_CLIENT_SECRET, GOOGLE_CLIENT_SECRET; .dev.vars locally).
// local: a small stand-in provider that the dev and end-to-end scripts start on port 8792 (scripts/idp-stub.mjs),
// where a tester picks the address to sign in as. The Worker holds no stub and no switch.
const STUB = 'http://127.0.0.1:8792'
export const IDPS: Record<string, Record<Provider, Idp>> = {
  local: {
    microsoft: { authorize: `${STUB}/microsoft/authorize`, token: `${STUB}/microsoft/token`, keys: `${STUB}/microsoft/keys`, issuer: `${STUB}/microsoft/{tenantid}/v2.0`, clientId: 'ophis-business-local' },
    google: { authorize: `${STUB}/google/authorize`, token: `${STUB}/google/token`, keys: `${STUB}/google/keys`, issuer: `${STUB}/google`, clientId: 'ophis-business-local' },
  },
}
// The real endpoints, for the entry of a future environment (with the client ids of the two app registrations).
// THEY HAVE NEVER BEEN CALLED: no real Microsoft or Google account has signed in through this code.
// Microsoft: the "organizations" endpoints take work or school accounts only; the issuer is per tenant.
export const REAL_ENDPOINTS: Record<Provider, Omit<Idp, 'clientId'>> = {
  microsoft: {
    authorize: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    keys: 'https://login.microsoftonline.com/organizations/discovery/v2.0/keys', issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', keys: 'https://www.googleapis.com/oauth2/v3/certs', issuer: 'https://accounts.google.com' },
}
/** The tenant of personal Microsoft accounts (outlook.com, hotmail.com): never a company. */
export const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'
export const OIDC = { timeoutMs: 5000, maxBytes: 64 * 1024 }
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const random = (bytes: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
/** The temporary values of one sign-in: state, nonce and the PKCE verifier. They live in the flow cookie, never at the provider. */
export const newFlow = () => ({ state: random(16), nonce: random(16), verifier: random(32) })

/** Where the browser is sent. The provider sees the state, the nonce and the SHA-256 of the verifier, never the verifier. */
export async function authorizeUrl(idp: Idp, flow: { state: string; nonce: string; verifier: string }, redirect: string, hint: { email?: string | null; domain?: string | null } = {}) {
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))))
  const query = new URLSearchParams({
    client_id: idp.clientId, response_type: 'code', scope: 'openid email', redirect_uri: redirect, state: flow.state, nonce: flow.nonce,
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    // Hints only: what the token says is what counts. hd is Google's name for the company domain.
    ...(hint.email && { login_hint: hint.email }), ...(hint.domain && { hd: hint.domain }),
  })
  return `${idp.authorize}?${query}`
}

// One request to the provider, asked once: 5 seconds, 64 KB, no redirect followed. Null: no usable answer.
async function ask(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(OIDC.timeoutMs) })
    const answer = response.ok ? JSON.parse((await readCapped(response.body, OIDC.maxBytes)) ?? 'null') : null
    return answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : null
  } catch {
    return null
  }
}

/** The code for the ID token, at the token endpoint, with the client secret and the PKCE verifier. Null: refused. */
export async function exchange(idp: Idp, secret: string, code: string, verifier: string, redirect: string) {
  const answer = await ask(idp.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: idp.clientId, client_secret: secret, code_verifier: verifier }).toString(),
  })
  return typeof answer?.id_token === 'string' ? answer.id_token : null
}

export interface Identity { provider: Provider; tenant: string; subject: string; email: string }
/**
 * The ID token, verified in full. Null unless every line holds:
 *   signature   RS256, by the key of the provider's key set that the header names
 *   issuer      the constant; Microsoft: the constant with the token's own tenant, a work or school tenant, never the consumer one
 *   audience    this client, and no other
 *   expiry      not passed
 *   nonce       the one of this browser's flow
 *   subject     present
 *   email       Google: email_verified is true, and the hd claim (the hosted domain) is present: it is the tenant
 *               Microsoft: xms_edov is true ("the email domain owner has been verified"); the plain email claim alone
 *               "isn't guaranteed to be correct" (Microsoft, optional claims reference, read 2026-11-11)
 *               Microsoft: acct says member (0), not guest (1): a guest of the tenant is not of the company. An optional
 *               claim, asked for in the app registration; a token without it is refused
 * The caller compares the tenant with the pinned one and the email with the invited one.
 * ponytail: the key set is fetched at every sign-in, no cache: a handful of sign-ins a day.
 */
export async function verifyIdToken(idp: Idp, provider: Provider, token: string, nonce: string, now: number): Promise<Identity | null> {
  try {
    const [head, body, signature, more] = token.split('.')
    if (more !== undefined || !signature) return null
    const json = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>
    const header = json(head)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null
    const set = await ask(idp.keys)
    const jwk = (Array.isArray(set?.keys) ? (set.keys as Record<string, unknown>[]) : []).find((key) => key?.kid === header.kid && key.kty === 'RSA' && (key.use ?? 'sig') === 'sig')
    if (!jwk) return null
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: String(jwk.n), e: String(jwk.e), alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(signature), new TextEncoder().encode(`${head}.${body}`)))) return null
    const c = json(body)
    const tid = typeof c.tid === 'string' ? c.tid.toLowerCase() : ''
    if (provider === 'microsoft' && (!GUID.test(tid) || tid === CONSUMER_TENANT)) return null
    if (c.iss !== idp.issuer.replace('{tenantid}', tid)) return null
    if (c.aud !== idp.clientId) return null
    if (typeof c.exp !== 'number' || c.exp * 1000 <= now) return null
    if (typeof c.nonce !== 'string' || c.nonce !== nonce) return null
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255 || /\s/.test(c.sub)) return null
    if (typeof c.email !== 'string' || !c.email || c.email.length > 254) return null
    if (provider === 'google' ? c.email_verified !== true || typeof c.hd !== 'string' || !c.hd : c.xms_edov !== true || (c.acct !== 0 && c.acct !== '0')) return null
    return { provider, tenant: provider === 'google' ? (c.hd as string).toLowerCase() : tid, subject: c.sub, email: c.email.toLowerCase() }
  } catch {
    return null
  }
}
