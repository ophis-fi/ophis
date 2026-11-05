import { afterEach, beforeAll, expect, it } from 'vitest'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Wallet } from 'ethers'
import { MAX_UNLOCK_BYTES, openOperator, sealOperator } from '../src/custody'
import { receiveUnlock, sendUnlock } from '../src/unlock-socket'
import { parseMainnetSecrets } from '../src/storage'

let publicKey: Buffer, pkcs1PublicKey: Buffer, x509Certificate: Buffer, privateKey: Buffer, wrongKey: Buffer
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 })
  publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  pkcs1PublicKey = Buffer.from(pair.publicKey.export({ type: 'pkcs1', format: 'pem' }))
  privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  wrongKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const signed = spawnSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', '/dev/stdin',
    '-subj', '/CN=Ophis Synthetic Custody Test', '-days', '1', '-sha256'], { input: privateKey, timeout: 10_000 })
  if (signed.status !== 0) throw new Error('Synthetic X.509 fixture creation failed.')
  x509Certificate = signed.stdout
}, 20_000)

it.each(['SPKI', 'PKCS1', 'X509'])('encrypts all operator fields with randomized authenticated encryption using %s and an off-server recovery key', (format) => {
  const data = Buffer.from(JSON.stringify({ gasKey: 'dummy gas secret', feeMnemonic: 'dummy fee secret', encryptionKey: 'dummy database secret' }))
  const certificate = format === 'X509' ? x509Certificate : format === 'PKCS1' ? pkcs1PublicKey : publicKey
  const a = sealOperator(data, certificate), b = sealOperator(data, certificate)
  expect(a.equals(b)).toBe(false)
  expect(a.toString()).not.toContain('dummy')
  expect(openOperator(a, privateKey)).toEqual(data)
  expect(() => openOperator(a, wrongKey)).toThrow()
})

it.each([
  ['concatenated public keys', () => Buffer.concat([publicKey, Buffer.from(createPublicKey(wrongKey).export({ type: 'spki', format: 'pem' }))])],
  ['certificate plus another public key', () => Buffer.concat([x509Certificate, Buffer.from(createPublicKey(wrongKey).export({ type: 'spki', format: 'pem' }))])],
  ['public plus private key', () => Buffer.concat([publicKey, privateKey])],
  ['bare private key', () => privateKey],
  ['mismatched footer', () => Buffer.from(publicKey.toString().replace('-----END PUBLIC KEY-----', '-----END RSA PUBLIC KEY-----'))],
  ['trailing block', () => Buffer.concat([publicKey, Buffer.from('-----BEGIN COMMENT-----\nYQ==\n-----END COMMENT-----\n')])],
  ['DER instead of PEM', () => createPublicKey(publicKey).export({ type: 'spki', format: 'der' })],
  ['oversized certificate', () => Buffer.alloc(32 * 1024 + 1, 'A')],
  ['noncanonical Base64', () => Buffer.from('-----BEGIN PUBLIC KEY-----\nAA=A\n-----END PUBLIC KEY-----\n')],
  ['weak RSA', () => Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }))],
  ['RSA above the 8192-bit envelope limit', () => createPublicKey({ key: { kty: 'RSA', n: Buffer.alloc(1025, 0xff).toString('base64url'), e: 'AQAB' }, format: 'jwk' }).export({ type: 'spki', format: 'pem' })],
  ['nonstandard RSA exponent', () => Buffer.from(generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 3 }).publicKey.export({ type: 'spki', format: 'pem' }))],
  ['non-RSA public key', () => Buffer.from(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }))],
] as const)('rejects %s through the shared sealer before encryption', (_kind, input) => {
  const certificate = Buffer.from(input())
  if (_kind === 'RSA above the 8192-bit envelope limit') expect(createPublicKey(certificate).asymmetricKeyDetails?.modulusLength).toBeGreaterThan(8192)
  expect(() => sealOperator(Buffer.from('synthetic operator secret'), certificate)).toThrow()
})

it('rejects nonzero unused Base64 pad bits even when Node accepts the identical public-key DER', () => {
  const canonical = publicKey.toString().split('\n').filter((line) => line && !line.startsWith('-----')).join('')
  const padding = canonical.endsWith('==') ? 2 : canonical.endsWith('=') ? 1 : 0
  expect(padding).toBeGreaterThan(0)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', index = canonical.length - padding - 1
  const altered = canonical.slice(0, index) + alphabet[alphabet.indexOf(canonical[index]) | 1] + canonical.slice(index + 1)
  const certificate = Buffer.from('-----BEGIN PUBLIC KEY-----\n' + altered.match(/.{1,64}/g)!.join('\n') + '\n-----END PUBLIC KEY-----\n')
  const actualDER = createPublicKey(certificate).export({ type: 'spki', format: 'der' })
  expect(actualDER.equals(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))).toBe(true)
  expect(altered === canonical).toBe(false)
  expect(() => sealOperator(Buffer.from('synthetic operator secret'), certificate)).toThrow('Invalid operator public certificate.')
})

it.each(['iv', 'tag', 'ciphertext', 'wrappedKey'])('rejects changed %s without returning unauthenticated plaintext', (field) => {
  const value = JSON.parse(sealOperator(Buffer.from('secret'), publicKey).toString())
  value[field] = (value[field][0] === '0' ? '1' : '0') + value[field].slice(1)
  expect(() => openOperator(Buffer.from(JSON.stringify(value)), privateKey)).toThrow()
})

it('bounds encrypted and decrypted input and rejects unsupported formats', () => {
  expect(() => sealOperator(Buffer.alloc(MAX_UNLOCK_BYTES + 1), publicKey)).toThrow('size')
  expect(() => openOperator(Buffer.alloc(25 * 1024), privateKey)).toThrow('Invalid')
  const value = JSON.parse(sealOperator(Buffer.from('secret'), publicKey).toString()); value.version = 2
  expect(() => openOperator(Buffer.from(JSON.stringify(value)), privateKey)).toThrow('Invalid')
})

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('keeps the unlock socket private, rejects bad keys, accepts once and relocks on a fresh process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-unlock-')); directories.push(root)
  const path = join(root, 'private', 'unlock.sock'), signal = new AbortController()
  const gas = Wallet.createRandom(), secrets = { gasKey: gas.privateKey, encryptionKey: 'aa'.repeat(32), feeViewingKey: 'ab'.repeat(80) }
  const gate = await receiveUnlock(path, (data) => parseMainnetSecrets(data, gas.address), signal.signal)
  try {
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await expect(sendUnlock(path, Buffer.from(JSON.stringify({ ...secrets, gasKey: Wallet.createRandom().privateKey })))).rejects.toThrow('rejected')
    await expect(sendUnlock(path, Buffer.from(JSON.stringify({ ...secrets, feeMnemonic: Wallet.createRandom().mnemonic!.phrase })))).rejects.toThrow('rejected')
    await sendUnlock(path, Buffer.from(JSON.stringify(secrets)))
    expect(await gate.value).toEqual(secrets)
    await expect(sendUnlock(path, Buffer.from(JSON.stringify(secrets)))).rejects.toThrow()
  } finally { await gate.close() }
  const next = await receiveUnlock(path, () => true, signal.signal)
  signal.abort()
  await expect(next.value).rejects.toThrow('stopped')
  await next.close()
})

it('refuses an oversized unlock before opening a connection', async () => {
  await expect(sendUnlock('/does-not-exist', Buffer.alloc(MAX_UNLOCK_BYTES + 1))).rejects.toThrow('Invalid')
})
