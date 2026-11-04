import { constants, closeSync, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Wallet } from 'ethers'
import { DatabaseSync } from 'node:sqlite'
import type { Settings } from './config'
import { sealOperator } from './custody'
import { RailgunSDK } from './sdk'
import { privateFile, readSecrets, type Secrets, type Store } from './storage'

function durableCreate(path: string, data: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export async function migrateOperator(config: Settings, store: Store, certificatePath: string) {
  if (config.enabled || store.pending().length) throw new Error('Migration requires an unarmed operator with no unresolved requests or fees.')
  const journalPath = join(config.state, 'protected-transactions.sqlite')
  if (existsSync(journalPath)) {
    privateFile(journalPath, true)
    const journal = new DatabaseSync(journalPath, { readOnly: true })
    try {
      if ((journal.prepare('SELECT COUNT(*) AS count FROM pending').get()?.count ?? 0) !== 0)
        throw new Error('Reconcile the protected transport journal before migration.')
    } finally { journal.close() }
  }
  const legacy = readSecrets(config.secrets)
  if (!legacy.feeMnemonic) throw new Error('Migration requires the original operator record.')
  const certificate = privateFile(certificatePath)
  const root = dirname(config.secrets)
  const original = Buffer.from(JSON.stringify(legacy))
  let sdk: RailgunSDK | undefined
  try {
    const retired = sealOperator(original, certificate)
    durableCreate(join(root, 'operator-retired.sealed.json'), retired)
    sdk = new RailgunSDK(config, legacy, store)
    await sdk.start()
    const encryptionKey = randomBytes(32).toString('hex')
    const view = await sdk.prepareViewOnly(encryptionKey)
    const gas = Wallet.createRandom()
    const runtime: Secrets = { gasKey: gas.privateKey, encryptionKey, feeViewingKey: view.viewingKey }
    const clear = Buffer.from(JSON.stringify(runtime))
    let sealed: Buffer
    try { sealed = sealOperator(clear, certificate) } finally { clear.fill(0) }
    durableCreate(join(root, 'operator.sealed.json'), sealed)
    const metadata = { gasWalletAddress: gas.address, feeIdentity: sdk.address, viewOnly: true,
      retiredGasWalletAddress: new Wallet(legacy.gasKey).address,
      runtimeSha256: createHash('sha256').update(sealed).digest('hex'),
      retiredSha256: createHash('sha256').update(retired).digest('hex'), legacyRemovalPending: true }
    durableCreate(join(root, 'operator-public.json'), Buffer.from(JSON.stringify(metadata, null, 2)))
    store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('walletId', view.id)
    return metadata
  } finally { original.fill(0); await sdk?.stop() }
}
