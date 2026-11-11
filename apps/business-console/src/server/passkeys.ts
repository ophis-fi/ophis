// Passkeys: per-environment constants, stateless challenges, the two verifications, the three-word phrase.
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { WORDS } from './words.ts'

// The relying-party id and the origin are constants per environment, never taken from a request.
// The relying-party id is the full app hostname, so no sibling site can ask for the passkey.
// A hostname is final once it is listed here: passkeys are tied to it (security-design.md, decision 2).
export interface Config { rpId: string; origin: string }
const ENVIRONMENTS: Record<string, Config> = {
  local: { rpId: 'localhost', origin: 'http://localhost:8787' },
}
export function configFor(environment: string): Config {
  if (!Object.hasOwn(ENVIRONMENTS, environment)) throw new Error('unknown ENVIRONMENT')
  return ENVIRONMENTS[environment]
}

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
export type Purpose = 'signin' | 'enrol' | 'stepup' | 'add' | 'confirm' | 'stop'
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

// ---- the three-word phrase (recovery.md section 2) ----
// credentialHash = SHA-256(credential id ‖ COSE public key)
// phrase = words3(SHA-256("ophis-enrol-v1" ‖ site ‖ org id ‖ seat id ‖ role ‖ purpose ‖ credentialHash ‖ nonce))
// Every field carries a 4-byte big-endian length. Text is UTF-8; the hash and the nonce are raw bytes.
async function hashFields(fields: (string | Uint8Array)[]) {
  const parts = fields.map((field) => (typeof field === 'string' ? text.encode(field) : field))
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

/** The first 8 bytes as an integer, modulo 1296^3, written as three words: 31 bits. The nonce is 128 server bits, in hex. */
export async function phraseFor(p: { site: string; orgId: string; seatId: string; role: string; purpose: string; credentialHash: Uint8Array; nonce: string }) {
  const nonce = Uint8Array.from(p.nonce.match(/../g) ?? [], (pair) => parseInt(pair, 16))
  const digest = await hashFields(['ophis-enrol-v1', p.site, p.orgId, p.seatId, p.role, p.purpose, p.credentialHash, nonce])
  const n = new DataView(digest.buffer).getBigUint64(0) % 1296n ** 3n
  return [n / 1296n ** 2n, (n / 1296n) % 1296n, n % 1296n].map((index) => WORDS[Number(index)])
}
