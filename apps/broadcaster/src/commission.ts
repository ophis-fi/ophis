import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import LevelDOWN from 'leveldown'
import { Mnemonic, Wallet, hexlify } from 'ethers'
import { ArtifactStore, createRailgunWallet, createViewOnlyRailgunWallet, getWalletShareableViewingKey,
  hasEngine, setLoggers, startRailgunEngine, stopRailgunEngine, viewOnlyWalletForID } from '@railgun-community/wallet'
import { parseOperatorPublicKey, sealOperator } from './custody'
import { parseMainnetSecrets, parseSecrets } from './secrets'

const failure = () => new Error('Offline BNB commissioning failed. Preserve any created output; no secret values were logged.')
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
let commissioning = false

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function durableCreate(path: string, data: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  syncDirectory(dirname(path))
}

function readCertificate(path: string): { data: Buffer; spkiSha256: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 32 * 1024) throw failure()
    const data = readFileSync(fd), publicKey = parseOperatorPublicKey(data)
    return { data, spkiSha256: sha256(publicKey.export({ type: 'spki', format: 'der' })) }
  } finally { closeSync(fd) }
}

function sealedRecord(value: unknown, certificate: Buffer, runtimeAddress?: string): Buffer {
  const clear = Buffer.from(JSON.stringify(value))
  try {
    if (runtimeAddress) parseMainnetSecrets(clear, runtimeAddress)
    else parseSecrets(clear)
    return sealOperator(clear, certificate)
  } finally { clear.fill(0) }
}

/** Owner-machine only: fixed chain56, no provider, upload, signing, existing pins or installation. */
export async function commissionBNB(certificatePath: string, outputDirectory: string) {
  if (commissioning || hasEngine()) throw failure()
  commissioning = true
  let temporary: string | undefined, started = false
  let database: ReturnType<typeof LevelDOWN> | undefined
  try {
    if (!isAbsolute(certificatePath) || !isAbsolute(outputDirectory)) throw failure()
    const output = resolve(outputDirectory), parent = lstatSync(dirname(output))
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022)) throw failure()
    const { data: certificate, spkiSha256: certificateSpkiSha256 } = readCertificate(certificatePath)
    // Non-recursive creation refuses every existing file, directory or symlink.
    mkdirSync(output, { mode: 0o700 })
    const directory = lstatSync(output)
    if (!directory.isDirectory() || directory.uid !== parent.uid || (directory.mode & 0o777) !== 0o700) throw failure()
    syncDirectory(dirname(output))
    const gas = new Wallet(hexlify(randomBytes(32)))
    const retired = { gasKey: gas.privateKey, feeMnemonic: Mnemonic.fromEntropy(randomBytes(32)).phrase,
      encryptionKey: randomBytes(32).toString('hex') }
    const sealedRetired = sealedRecord(retired, certificate)
    // Retain recovery ciphertext before any SDK work that can fail.
    durableCreate(join(output, 'operator-retired.sealed.json'), sealedRetired)
    temporary = mkdtempSync(join(output, '.commission-wallet-'))
    database = new LevelDOWN(join(temporary, 'wallet-db'))
    const unavailable = async (): Promise<never> => { throw failure() }
    const artifacts = new ArtifactStore(unavailable, unavailable, async () => false)
    setLoggers(() => {}, () => {})
    started = true
    // No provider is loaded: wallet derivation works without starting any network/history sync.
    await startRailgunEngine('ophiscommission', database, false, artifacts, false, false)
    const full = await createRailgunWallet(retired.encryptionKey, retired.feeMnemonic, undefined)
    const feeViewingKey = await getWalletShareableViewingKey(full.id)
    if (!feeViewingKey) throw failure()
    const runtime = { gasKey: gas.privateKey, feeViewingKey, encryptionKey: randomBytes(32).toString('hex') }
    const view = await createViewOnlyRailgunWallet(runtime.encryptionKey, feeViewingKey, undefined)
    viewOnlyWalletForID(view.id)
    if (view.railgunAddress !== full.railgunAddress || await getWalletShareableViewingKey(view.id) !== feeViewingKey) throw failure()
    const sealedRuntime = sealedRecord(runtime, certificate, gas.address)
    durableCreate(join(output, 'operator.sealed.json'), sealedRuntime)
    const identity = { gasWalletAddress: gas.address, runtimeSha256: sha256(sealedRuntime), retiredSha256: sha256(sealedRetired) }
    const metadata = { version: 1, chainId: 56, ...identity, feeIdentity: full.railgunAddress, viewOnly: true,
      createdAtUtc: new Date().toISOString(), certificateSha256: sha256(certificate), certificateSpkiSha256, signingEnabled: false, funded: false }
    durableCreate(join(output, 'operator-public.json'), Buffer.from(JSON.stringify(metadata, null, 2) + '\n'))
    durableCreate(join(output, 'operator-identities.candidate.json'), Buffer.from(JSON.stringify({ version: 1, chains: { '56': identity } }, null, 2) + '\n'))
    return metadata
  } catch { throw failure() }
  finally {
    let cleanupFailed = false
    try {
      try { if (started) await stopRailgunEngine() } catch { cleanupFailed = true }
      try {
        if (database) await new Promise<void>((done, reject) => database!.close((error) => error ? reject(error) : done()))
      } catch { cleanupFailed = true }
      try { if (temporary) rmSync(temporary, { recursive: true, force: true }) } catch { cleanupFailed = true }
      try { if (temporary) syncDirectory(dirname(temporary)) } catch { cleanupFailed = true }
    }
    finally { commissioning = false }
    if (cleanupFailed) throw failure()
  }
}
