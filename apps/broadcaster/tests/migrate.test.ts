import { expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullWalletForID, getWalletMnemonic, signWithWalletViewingKey, verifyBroadcasterSignature, getRailgunWalletAddressData } from '@railgun-community/wallet'
import { openOperator } from '../src/custody'
import { migrateOperator } from '../src/migrate'
import { initializeSecrets, parseMainnetSecrets, readSecrets, Store } from '../src/storage'
import { RailgunSDK } from '../src/sdk'
import { snapshotCriticalState } from '../src/backup'
import { config } from './request.fixture'

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
    sdk = new RailgunSDK({ ...settings, state }, runtime, restored)
    await sdk.start()
    expect(sdk.address).toBe(metadata.feeIdentity)
    expect(() => fullWalletForID(sdk!.walletId)).toThrow('View-Only')
  } finally { await sdk?.stop(); restored?.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
}, 20_000)
