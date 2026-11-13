// Passkeys: per-environment constants, stateless challenges, the two verifications, the hash of a passkey.
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'

// The relying-party id and the origin are constants per environment, never taken from a request.
// The relying-party id is the full app hostname, so no sibling site can ask for the passkey.
// A hostname is final once it is listed here: passkeys are tied to it (security-design.md, decision 2).
// The signing page has its own hostname (signOrigin), served by the same Worker: a wallet or the Safe interface
// opens it, never the console. chains: the two JSON-RPC endpoints of each chain a wallet can be pinned to, from
// different operators; both must agree before a contract wallet's answer counts (chain.ts).
// ponytail: public endpoints for the local build. Production endpoints are decided later.
export interface Config { rpId: string; origin: string; signOrigin: string; chains: Record<number, readonly [string, string]> }
const ENVIRONMENTS: Record<string, Config> = {
  local: {
    rpId: 'localhost', origin: 'http://localhost:8787', signOrigin: 'http://127.0.0.1:8787',
    chains: {
      1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
      10: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
      8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
      42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    },
  },
}
export function configFor(environment: string): Config {
  if (!Object.hasOwn(ENVIRONMENTS, environment)) throw new Error('unknown ENVIRONMENT')
  return ENVIRONMENTS[environment]
}
// Milestone 6: the hostname of the Support provider (TypeSafe AI, USA), per environment like the constants above and
// never read from a request. Its key is the Worker secret TYPESAFE_API_KEY (support.ts).
export const SUPPORT_HOSTS: Record<string, string> = { local: 'api.typesafe.ai' }

const ALGORITHMS = [-7, -8, -257] // ES256, EdDSA, RS256
const CHALLENGE_MS = 5 * 60_000
const text = new TextEncoder()

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

// A challenge is 16 random bytes, an expiry and an HMAC over purpose, binding and both. Sign-in start
// therefore writes no row: the server recognises its own challenge when it comes back.
// A used sign-in challenge is recorded with the session it opened (sessions.challenge_hash), so a replay fails.
// Every other purpose binds a value that its own use changes (see index.ts), so it also works once.
export type Purpose = 'signin' | 'enrol' | 'stepup' | 'add' | 'confirm' | 'stop' | 'recover' | 'continue' | 'apply'
function hmacKey(secret: string) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('CHALLENGE_KEY is missing or too short')
  return crypto.subtle.importKey('raw', text.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
function macInput(purpose: string, binding: string, head: Uint8Array) {
  const label = text.encode(`${purpose}\n${binding}\n`)
  const input = new Uint8Array(label.length + head.length)
  input.set(label)
  input.set(head, label.length)
  return input
}
export async function newChallenge(secret: string, purpose: Purpose, binding: string, now: number) {
  const bytes = new Uint8Array(56)
  crypto.getRandomValues(bytes.subarray(0, 16))
  new DataView(bytes.buffer).setBigUint64(16, BigInt(now + CHALLENGE_MS))
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), macInput(purpose, binding, bytes.subarray(0, 24)))
  bytes.set(new Uint8Array(mac), 24)
  return toBase64Url(bytes)
}
export async function challengeIsOurs(secret: string, purpose: Purpose, binding: string, challenge: string, now: number) {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(challenge)
  } catch {
    return false
  }
  if (bytes.length !== 56) return false
  if (Number(new DataView(bytes.buffer).getBigUint64(16)) < now) return false
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes.subarray(24), macInput(purpose, binding, bytes.subarray(0, 24)))
}

// A text the server writes to itself and holds nowhere: base64url(JSON) "." base64url(HMAC), with the challenge key
// under the text's own label, so that it never passes for a challenge or for a text of another kind.
export async function seal(secret: string, label: string, fields: object) {
  const body = text.encode(JSON.stringify(fields))
  return `${toBase64Url(body)}.${toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), macInput(label, '', body))))}`
}
/** The fields, if the MAC is ours for this label. Null otherwise: nothing of a text that fails is read. */
export async function unseal(secret: string, label: string, sealed: string): Promise<unknown> {
  const key = await hmacKey(secret)
  try {
    const [body, mac, more] = sealed.split('.')
    const [bytes, tag] = [fromBase64Url(body), fromBase64Url(mac)]
    // One spelling only: atob also reads padding, the other alphabet, spaces and spare bits, and a text that is used
    // up once (an application code) must not come back as another text.
    if (more !== undefined || toBase64Url(bytes) !== body || toBase64Url(tag) !== mac || !(await crypto.subtle.verify('HMAC', key, tag, macInput(label, '', bytes)))) return null
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

// The user handle of a seat's passkeys is the seat id: random, no personal data.
export const userHandle = (seatId: string) => toBase64Url(text.encode(seatId))

// exclude: passkeys the seat already has. A security key that holds one of them refuses, instead of
// replacing it with the new one (same site, same user handle) and leaving the server with a dead entry.
export function creationOptions(config: Config, challenge: string, seat: { id: string; name: string }, hardware: boolean, exclude: string[] = []) {
  return {
    excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
    rp: { id: config.rpId, name: 'Ophis Business' },
    user: { id: userHandle(seat.id), name: seat.name, displayName: seat.name },
    challenge,
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    hints: hardware ? ['security-key'] : [],
    timeout: 120_000,
  }
}
// allow: inside a session, the passkeys of the member's own seat, so the browser offers no other.
export const requestOptions = (config: Config, challenge: string, allow?: string[]) =>
  ({ rpId: config.rpId, challenge, userVerification: 'required', timeout: 120_000, ...(allow && { allowCredentials: allow.map((id) => ({ type: 'public-key', id })) }) })

export async function verifyRegistration(config: Config, response: unknown, challengeOk: (challenge: string) => Promise<boolean>) {
  const result = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: challengeOk,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: ALGORITHMS,
  })
  if (!result.verified) throw new Error('registration not verified')
  const { credential, credentialDeviceType } = result.registrationInfo
  return {
    id: credential.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    // Without attestation this flag is the authenticator's own statement (recovery.md section 7).
    deviceBound: credentialDeviceType === 'singleDevice',
    transports: credential.transports ?? [],
  }
}

export async function verifyAssertion(
  config: Config,
  response: unknown,
  stored: { id: string; public_key: string; counter: number },
  challengeOk: (challenge: string) => Promise<boolean>,
) {
  const result = await verifyAuthenticationResponse({
    response: response as AuthenticationResponseJSON,
    expectedChallenge: challengeOk,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    credential: { id: stored.id, publicKey: fromBase64Url(stored.public_key), counter: stored.counter },
  })
  if (!result.verified) throw new Error('assertion not verified')
  return result.authenticationInfo.newCounter
}

// ---- the hash of a passkey: what a confirmation and a wallet's proof are bound to ----
// credentialHash = SHA-256(credential id ‖ COSE public key), each field with a 4-byte big-endian length.
async function hashFields(parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + 4 + part.length, 0))
  let at = 0
  for (const part of parts) {
    new DataView(bytes.buffer).setUint32(at, part.length)
    bytes.set(part, at + 4)
    at += 4 + part.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}
export const credentialHash = (credentialId: string, publicKey: string) => hashFields([fromBase64Url(credentialId), fromBase64Url(publicKey)])
