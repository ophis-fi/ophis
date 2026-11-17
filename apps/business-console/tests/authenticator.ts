// A small software authenticator for unit tests: one ES256 passkey that answers WebAuthn options the
// way a browser plus a security key would. `as` lets a test answer for another origin or relying party.
// A hand-made fixture can pass while a real browser fails, so tests/e2e.mjs proves the same flow in Chrome.
import { fromBase64Url, toBase64Url } from '../src/server/passkeys.ts'

const text = new TextEncoder()
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const join = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]))

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>
function cbor(value: Cbor): number[] {
  const head = (major: number, n: number) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255])
  if (typeof value === 'number') return value < 0 ? head(1, -1 - value) : head(0, value)
  if (typeof value === 'string') return [...head(3, text.encode(value).length), ...text.encode(value)]
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value]
  return [...head(5, value.size), ...[...value].flatMap(([k, v]) => [...cbor(k), ...cbor(v)])]
}
function der(raw: Uint8Array) {
  const int = (part: Uint8Array) => {
    let bytes = [...part]
    while (bytes.length > 1 && bytes[0] === 0) bytes.shift()
    if (bytes[0] & 0x80) bytes = [0, ...bytes]
    return [2, bytes.length, ...bytes]
  }
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))]
  return Uint8Array.from([0x30, body.length, ...body])
}

export interface Site { origin: string; rpId: string }
// counter: answer with this signature counter instead of the next one, as a copy of the key would.
interface Answer { as?: Partial<Site>; userVerified?: boolean; userHandle?: string; counter?: number }

// counts: false is a passkey whose signature counter stays 0, as most synced and many hardware keys do.
export async function softwareAuthenticator(site: Site, { backupEligible = false, counts = true } = {}) {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
  const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x!)], [-3, fromBase64Url(jwk.y!)]]))
  const credentialId = crypto.getRandomValues(new Uint8Array(32))
  const id = toBase64Url(credentialId)
  let counter = 0
  let handle = ''

  async function authData(a: Answer, attested: boolean) {
    const flags = 0x01 | (a.userVerified === false ? 0 : 0x04) | (backupEligible ? 0x08 : 0) | (attested ? 0x40 : 0)
    if (counts) counter += 1
    return join(
      await sha256(text.encode(a.as?.rpId ?? site.rpId)),
      [flags, 0, 0, (a.counter ?? counter) >> 8, (a.counter ?? counter) & 255],
      attested ? join(new Uint8Array(16), [0, credentialId.length], credentialId, cose) : [],
    )
  }
  const clientData = (type: string, challenge: string, a: Answer) =>
    text.encode(JSON.stringify({ type, challenge, origin: a.as?.origin ?? site.origin, crossOrigin: false }))

  return {
    id,
    async register(options: { challenge: string; user: { id: string } }, a: Answer = {}) {
      handle = options.user.id
      const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', await authData(a, true)]]))
      return {
        id, rawId: id, type: 'public-key', authenticatorAttachment: 'cross-platform', clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientData('webauthn.create', options.challenge, a)),
          attestationObject: toBase64Url(Uint8Array.from(attestationObject)),
          transports: ['usb'],
        },
      }
    },
    async authenticate(options: { challenge: string }, a: Answer = {}) {
      const data = await authData(a, false)
      const client = clientData('webauthn.get', options.challenge, a)
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, join(data, await sha256(client)))
      return {
        id, rawId: id, type: 'public-key', authenticatorAttachment: 'cross-platform', clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(client),
          authenticatorData: toBase64Url(data),
          signature: toBase64Url(der(new Uint8Array(signature))),
          userHandle: a.userHandle ?? handle,
        },
      }
    },
  }
}
