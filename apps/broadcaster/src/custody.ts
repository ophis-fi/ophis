import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto'

const aad = Buffer.from('ophis-broadcaster-operator-v1')
export const MAX_UNLOCK_BYTES = 8192

export function parseOperatorPublicKey(certificate: Buffer) {
  if (!certificate.length || certificate.length > 32 * 1024) throw new Error('Invalid operator public certificate.')
  const pem = certificate.toString('utf8')
  const block = /^-----BEGIN (CERTIFICATE|(?:RSA )?PUBLIC KEY)-----\r?\n([A-Za-z0-9+/]+={0,2}(?:\r?\n[A-Za-z0-9+/]+={0,2})*)\r?\n-----END \1-----(?:\r?\n)?$/.exec(pem)
  if (!block || block[0].length !== pem.length) throw new Error('Invalid operator public certificate.')
  const body = block[2].replace(/\r?\n/g, '')
  if (Buffer.from(body, 'base64').toString('base64') !== body) throw new Error('Invalid operator public certificate.')
  const publicKey = createPublicKey(certificate)
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) > 8192)
    throw new Error('Operator encryption requires an RSA certificate of at least 3072 bits.')
  if (publicKey.asymmetricKeyDetails?.publicExponent !== 65537n) throw new Error('Operator encryption requires RSA exponent 65537.')
  return publicKey
}

function envelope(data: Buffer): { version: number; wrappedKey: string; iv: string; tag: string; ciphertext: string } {
  if (data.length > 24 * 1024) throw new Error('Invalid encrypted operator file.')
  const value = JSON.parse(data.toString())
  const hex = (v: unknown, min: number, max = min) => typeof v === 'string' && v.length >= min && v.length <= max && v.length % 2 === 0 && /^[0-9a-f]+$/.test(v)
  if (!value || value.version !== 1 || !hex(value.wrappedKey, 768, 2048) || !hex(value.iv, 24) ||
    !hex(value.tag, 32) || !hex(value.ciphertext, 2, MAX_UNLOCK_BYTES * 2)) throw new Error('Invalid encrypted operator file.')
  return value
}

export function sealOperator(data: Buffer, certificate: Buffer): Buffer {
  if (!data.length || data.length > MAX_UNLOCK_BYTES) throw new Error('Invalid operator payload size.')
  const publicKey = parseOperatorPublicKey(certificate)
  const key = randomBytes(32), iv = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
    const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
    return Buffer.from(JSON.stringify({ version: 1, wrappedKey: wrappedKey.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') }))
  } finally { key.fill(0) }
}

export function openOperator(data: Buffer, recoveryKey: Buffer): Buffer {
  const value = envelope(data)
  const privateKey = createPrivateKey(recoveryKey)
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072)
    throw new Error('Invalid operator recovery key.')
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(value.wrappedKey, 'hex'))
  try {
    if (key.length !== 32) throw new Error('Invalid operator encryption key.')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'), { authTagLength: 16 })
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(value.tag, 'hex'))
    const clear = decipher.update(Buffer.from(value.ciphertext, 'hex'))
    try { return Buffer.concat([clear, decipher.final()]) } finally { clear.fill(0) }
  } finally { key.fill(0) }
}
