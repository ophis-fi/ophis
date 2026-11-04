import { afterEach, beforeAll, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Wallet } from 'ethers'
import { MAX_UNLOCK_BYTES, openOperator, sealOperator } from '../src/custody'
import { receiveUnlock, sendUnlock } from '../src/unlock-socket'
import { parseMainnetSecrets } from '../src/storage'

let publicKey: Buffer, privateKey: Buffer, wrongKey: Buffer
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 })
  publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  wrongKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
}, 20_000)

it('encrypts all operator fields with randomized authenticated encryption and an off-server recovery key', () => {
  const data = Buffer.from(JSON.stringify({ gasKey: 'dummy gas secret', feeMnemonic: 'dummy fee secret', encryptionKey: 'dummy database secret' }))
  const a = sealOperator(data, publicKey), b = sealOperator(data, publicKey)
  expect(a.equals(b)).toBe(false)
  expect(a.toString()).not.toContain('dummy')
  expect(openOperator(a, privateKey)).toEqual(data)
  expect(() => openOperator(a, wrongKey)).toThrow()
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
