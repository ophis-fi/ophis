import { expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullWalletForID, getWalletMnemonic, signWithWalletViewingKey, verifyBroadcasterSignature, getRailgunWalletAddressData } from '@railgun-community/wallet'
import { openOperator } from '../src/custody'
import { migrateOperator } from '../src/migrate'
import { initializeSecrets, parseMainnetSecrets, readSecrets, Store } from '../src/storage'
import { RailgunSDK } from '../src/sdk'
import { snapshotCriticalState } from '../src/backup'
import { config } from './request.fixture'
import { CHAIN_ID } from '../src/config'

it('preserves the fee address, rotates gas/DB keys, restarts view-only and retains a separate encrypted recovery record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'custody-migration-'))
  const path = join(root, 'secrets', 'operator.json')
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 })
  const privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  initializeSecrets(path, 'fork')
  const legacy = readSecrets(path)
  const certificate = join(root, 'certificate.pem')
  writeFileSync(certificate, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  const store = new Store(root), settings = { ...config, enabled: false, state: root, secrets: path }
  let sdk: RailgunSDK | undefined, restored: Store | undefined
  try {
    await expect(migrateOperator({ ...settings, enabled: true }, store, certificate)).rejects.toThrow('unarmed')
    const metadata = await migrateOperator(settings, store, certificate)
    expect(metadata.gasWalletAddress).not.toBe(metadata.retiredGasWalletAddress)
    expect(() => store.bindIdentity(CHAIN_ID, metadata.gasWalletAddress)).not.toThrow()
    expect(() => store.bindIdentity(CHAIN_ID, metadata.retiredGasWalletAddress)).toThrow('different network or gas wallet')
    const runtime = parseMainnetSecrets(openOperator(readFileSync(join(root, 'secrets', 'operator.sealed.json')), privateKey), metadata.gasWalletAddress)
    expect(runtime.feeMnemonic).toBeUndefined()
    expect(runtime.encryptionKey).not.toBe(legacy.encryptionKey)
    expect(JSON.parse(openOperator(readFileSync(join(root, 'secrets', 'operator-retired.sealed.json')), privateKey).toString())).toEqual(legacy)
    sdk = new RailgunSDK(settings, runtime, store)
    await sdk.start()
    expect(sdk.address).toBe(metadata.feeIdentity)
    expect(() => fullWalletForID(sdk!.walletId)).toThrow('View-Only')
    await expect(getWalletMnemonic(runtime.encryptionKey, sdk.walletId)).rejects.toThrow()
    const message = '1234', signature = await signWithWalletViewingKey(sdk.walletId, message)
    expect(await verifyBroadcasterSignature(signature, message, getRailgunWalletAddressData(sdk.address).viewingPublicKey)).toBe(true)
    await sdk.stop()
    writeFileSync(join(root, 'secrets', 'backup-cert.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    const snapshot = join(root, '.backup-snapshot.restore')
    await snapshotCriticalState(root, snapshot)
    const state = join(snapshot, 'state')
    restored = new Store(state)
    expect(() => restored!.bindIdentity(CHAIN_ID, metadata.gasWalletAddress)).not.toThrow()
    sdk = new RailgunSDK({ ...settings, state }, runtime, restored)
    await sdk.start()
    expect(sdk.address).toBe(metadata.feeIdentity)
    expect(() => fullWalletForID(sdk!.walletId)).toThrow('View-Only')
  } finally { await sdk?.stop(); restored?.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
}, 20_000)

it.each(['bound', 'historical'])( 'refuses %s custody rotation before creating recovery files', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'custody-identity-'))
  const store = new Store(root)
  try {
    if (kind === 'bound') store.bindIdentity(CHAIN_ID, '0x0000000000000000000000000000000000001234')
    else {
      store.signed('old', 'encrypted', 'oldraw', 'oldhash', 1n, 10n, 0)
      store.confirmed('old', 1n, Date.now()); store.assured('old')
    }
    const settings = { ...config, enabled: false, state: root, secrets: join(root, 'operator.json') }
    await expect(migrateOperator(settings, store, join(root, 'not-read.pem'))).rejects.toThrow('empty, unbound legacy operator')
    expect(existsSync(join(root, 'operator.sealed.json'))).toBe(false)
    expect(existsSync(join(root, 'operator-retired.sealed.json'))).toBe(false)
    if (kind === 'historical') expect(store.get('old')?.raw).toBe('oldraw')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it('rejects a malformed certificate before binding identity or creating migration files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'custody-invalid-certificate-')), path = join(root, 'secrets', 'operator.json')
  initializeSecrets(path, 'fork')
  const certificate = join(root, 'invalid-certificate.pem')
  writeFileSync(certificate, '-----BEGIN PUBLIC KEY-----\nAA=A\n-----END PUBLIC KEY-----\n', { mode: 0o600 })
  const store = new Store(root), bound = vi.spyOn(store, 'bindIdentity'), started = vi.spyOn(RailgunSDK.prototype, 'start')
  const before = readdirSync(root).sort(), legacy = readFileSync(path)
  try {
    await expect(migrateOperator({ ...config, enabled: false, state: root, secrets: path }, store, certificate)).rejects.toThrow('Invalid operator public certificate.')
    expect(bound.mock.calls.length).toBe(0); expect(started.mock.calls.length).toBe(0)
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM settings').get()?.count).toBe(0)
    expect(readdirSync(root).sort()).toEqual(before)
    expect(readdirSync(join(root, 'secrets'))).toEqual(['operator.json'])
    expect(readFileSync(path).equals(legacy)).toBe(true)
  } finally { bound.mockRestore(); started.mockRestore(); store.close(); rmSync(root, { recursive: true, force: true }) }
})
