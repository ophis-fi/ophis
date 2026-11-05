import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import LevelDOWN from 'leveldown'
import { RailgunEngine } from '@railgun-community/engine'
import { Wallet } from 'ethers'
import { ArtifactStore, createRailgunWallet, createViewOnlyRailgunWallet, getWalletShareableViewingKey,
  hasEngine, startRailgunEngine, stopRailgunEngine, viewOnlyWalletForID } from '@railgun-community/wallet'
import { commissionBNB } from '../src/commission'
import { openOperator } from '../src/custody'
import { openPinnedOperator } from '../src/owner-pins'
import { parseMainnetSecrets, parseSecrets } from '../src/secrets'

let publicKey: Buffer, x509Certificate: Buffer, privateKey: Buffer, weakPublicKey: Buffer, otherExponentKey: Buffer, root: string, certificate: string
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const expectedFiles = ['operator-identities.candidate.json', 'operator-public.json', 'operator-retired.sealed.json', 'operator.sealed.json']
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 })
  publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  weakPublicKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }))
  otherExponentKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 3 }).publicKey.export({ type: 'spki', format: 'pem' }))
  // Pipe the synthetic test key to OpenSSL; no plaintext private-key fixture is written.
  const signed = spawnSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', '/dev/stdin',
    '-subj', '/CN=Ophis Synthetic BNB Commission Test', '-days', '1', '-sha256'], { input: privateKey, timeout: 10_000 })
  if (signed.status !== 0) throw new Error('Synthetic X.509 fixture creation failed.')
  x509Certificate = signed.stdout
  expect(Buffer.from(new X509Certificate(x509Certificate).publicKey.export({ type: 'spki', format: 'pem' })).equals(publicKey)).toBe(true)
}, 20_000)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bnb-commission-test-'))
  certificate = join(root, 'public-certificate.pem')
  writeFileSync(certificate, publicKey, { mode: 0o644 })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network permitted in offline commissioning test.') }))
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('No socket permitted in offline commissioning test.') })
})
afterEach(async () => {
  if (hasEngine()) await stopRailgunEngine()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  syncBuiltinESMExports()
  rmSync(root, { recursive: true, force: true })
})
afterAll(() => { privateKey.fill(0) })

it.each(['PUBLIC KEY', 'CERTIFICATE'])('creates private durable ciphertext from %s while preserving full/view-only identity and candidate chain56 pins', async (format) => {
  const selectedCertificate = format === 'CERTIFICATE' ? x509Certificate : publicKey
  writeFileSync(certificate, selectedCertificate, { mode: 0o644 })
  const output = join(root, 'commissioned'), log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const metadata = await commissionBNB(certificate, output)
  expect(metadata.chainId).toBe(56); expect(metadata.signingEnabled).toBe(false); expect(metadata.funded).toBe(false)
  expect(metadata.viewOnly).toBe(true); expect(metadata.certificateSha256).toBe(sha256(selectedCertificate))
  expect(metadata.certificateSpkiSha256).toBe(sha256(createPublicKey(selectedCertificate).export({ type: 'spki', format: 'der' })))
  expect(statSync(output).mode & 0o777).toBe(0o700)
  expect(readdirSync(output).sort()).toEqual(expectedFiles)
  for (const file of expectedFiles) expect(statSync(join(output, file)).mode & 0o777).toBe(0o600)
  const runtimeFile = readFileSync(join(output, 'operator.sealed.json'))
  const retiredFile = readFileSync(join(output, 'operator-retired.sealed.json'))
  expect(metadata.runtimeSha256).toBe(sha256(runtimeFile)); expect(metadata.retiredSha256).toBe(sha256(retiredFile))
  const candidate = JSON.parse(readFileSync(join(output, 'operator-identities.candidate.json'), 'utf8'))
  expect(Object.keys(candidate.chains)).toEqual(['56']); expect(candidate.chains['56'].gasWalletAddress).toBe(metadata.gasWalletAddress)
  const runtimeClear = openPinnedOperator(runtimeFile, privateKey, candidate.chains['56'], 'runtime')
  const retiredClear = openPinnedOperator(retiredFile, privateKey, candidate.chains['56'], 'retired')
  try {
    const runtime = parseMainnetSecrets(runtimeClear, metadata.gasWalletAddress), retired = parseSecrets(retiredClear)
    expect(new Wallet(runtime.gasKey).address).toBe(metadata.gasWalletAddress)
    expect(runtime.gasKey === retired.gasKey).toBe(true)
    expect(runtime.feeMnemonic === undefined && !!runtime.feeViewingKey).toBe(true)
    expect(!!retired.feeMnemonic && retired.feeViewingKey === undefined).toBe(true)
    expect(runtime.encryptionKey !== retired.encryptionKey).toBe(true)
    // Reconstruct from the persisted encrypted records independently; no provider/artifacts/history.
    const db = new LevelDOWN(join(root, 'independent-wallet-check'))
    const unavailable = async (): Promise<never> => { throw new Error('Artifacts must not be used.') }
    await startRailgunEngine('ophischeck', db, false, new ArtifactStore(unavailable, unavailable, async () => false), false, false)
    try {
      const full = await createRailgunWallet(retired.encryptionKey, retired.feeMnemonic!, undefined)
      const view = await createViewOnlyRailgunWallet(runtime.encryptionKey, runtime.feeViewingKey!, undefined)
      viewOnlyWalletForID(view.id)
      expect(full.railgunAddress).toBe(metadata.feeIdentity); expect(view.railgunAddress).toBe(metadata.feeIdentity)
      expect(await getWalletShareableViewingKey(full.id) === runtime.feeViewingKey).toBe(true)
    } finally { await stopRailgunEngine() }
    const written = expectedFiles.map((name) => readFileSync(join(output, name)))
    for (const secret of [runtime.gasKey, runtime.encryptionKey, runtime.feeViewingKey!, retired.encryptionKey, retired.feeMnemonic!])
      expect(written.every((file) => !file.includes(secret))).toBe(true)
    expect(log.mock.calls.length).toBe(0)
    expect(vi.mocked(fetch).mock.calls.length).toBe(0)
    expect(vi.mocked(Socket.prototype.connect).mock.calls.length).toBe(0)
  } finally { runtimeClear.fill(0); retiredClear.fill(0) }
  expect(readFileSync(certificate).equals(selectedCertificate)).toBe(true)
  expect(existsSync(join(root, 'operator-identities.json'))).toBe(false)
})

it('uses distinct fresh gas and fee identities on independent commissions', async () => {
  const a = await commissionBNB(certificate, join(root, 'first'))
  const b = await commissionBNB(certificate, join(root, 'second'))
  expect(a.gasWalletAddress !== b.gasWalletAddress).toBe(true)
  expect(a.feeIdentity !== b.feeIdentity).toBe(true)
  expect(a.runtimeSha256 !== b.runtimeSha256 && a.retiredSha256 !== b.retiredSha256).toBe(true)
})

it('runs the explicit offline CLI from the reviewed external-dependency bundle and rejects ambiguous arguments', () => {
  writeFileSync(certificate, x509Certificate, { mode: 0o644 })
  const cli = join(root, 'commission.mjs'), output = join(root, 'cli-output')
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'))
  buildSync({ entryPoints: [fileURLToPath(new URL('../src/commission-cli.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: cli, logLevel: 'silent' })
  const args = ['--certificate', certificate, '--output', output]
  const preload = 'import { Socket } from "node:net"; const blocked=()=>{throw new Error("offline test")}; globalThis.fetch=blocked; Socket.prototype.connect=blocked'
  const run = (arguments_: string[]) => spawnSync(process.execPath, ['--import',
    `data:text/javascript,${encodeURIComponent(preload)}`, cli, ...arguments_],
    { encoding: 'utf8', timeout: 20_000 })
  const diagnostics = (text: string) => text.replace(/^\(node:\d+\) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided\.\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm, '')
  const invalid = run([...args, '--chain', '56'])
  expect(invalid.status).toBe(1); expect(invalid.stdout).toBe(''); expect(existsSync(output)).toBe(false)
  expect(diagnostics(invalid.stderr)).toBe('Use --certificate /absolute/public-certificate.pem --output /absolute/new-private-directory\n')
  const success = run(args)
  expect(success.status).toBe(0); expect(diagnostics(success.stderr)).toBe('')
  const metadata = JSON.parse(success.stdout)
  expect(metadata.chainId).toBe(56); expect(metadata.signingEnabled).toBe(false)
  expect(Object.keys(metadata).sort()).toEqual(['certificateSha256', 'certificateSpkiSha256', 'chainId', 'createdAtUtc', 'feeIdentity', 'funded',
    'gasWalletAddress', 'retiredSha256', 'runtimeSha256', 'signingEnabled', 'version', 'viewOnly'])
  expect(success.stdout).toBe(JSON.stringify(JSON.parse(readFileSync(join(output, 'operator-public.json'), 'utf8'))) + '\n')
  expect(readdirSync(output).sort()).toEqual(expectedFiles)
  const duplicate = run(args)
  expect(duplicate.status).toBe(1); expect(duplicate.stdout).toBe('')
  expect(diagnostics(duplicate.stderr)).toBe('Offline BNB commissioning failed. Preserve any created output; no secret values were logged.\n')
  const runtimeClear = openPinnedOperator(readFileSync(join(output, 'operator.sealed.json')), privateKey, metadata, 'runtime')
  const retiredClear = openPinnedOperator(readFileSync(join(output, 'operator-retired.sealed.json')), privateKey, metadata, 'retired')
  try {
    const runtime = parseMainnetSecrets(runtimeClear, metadata.gasWalletAddress), retired = parseSecrets(retiredClear)
    expect(new Wallet(runtime.gasKey).address).toBe(metadata.gasWalletAddress)
    expect(runtime.gasKey === retired.gasKey && runtime.feeMnemonic === undefined && retired.feeViewingKey === undefined).toBe(true)
    const forbidden = ['gasKey', 'encryptionKey', 'feeViewingKey', 'feeMnemonic', 'PRIVATE KEY',
      runtime.gasKey, runtime.encryptionKey, runtime.feeViewingKey!, retired.encryptionKey, retired.feeMnemonic!]
    const outputs = [invalid, success, duplicate].flatMap((result) => [result.stdout, result.stderr])
    expect(outputs.every((text) => forbidden.every((value) => !text.includes(value)))).toBe(true)
  } finally { runtimeClear.fill(0); retiredClear.fill(0) }
})

it.each(['directory', 'file', 'symlink', 'dangling symlink'])('refuses an existing %s target without overwriting it', async (kind) => {
  const target = join(root, 'target'), outside = join(root, 'existing')
  mkdirSync(outside, { mode: 0o700 }); writeFileSync(join(outside, 'marker'), 'preserve', { mode: 0o600 })
  if (kind === 'directory') mkdirSync(target, { mode: 0o700 })
  if (kind === 'file') writeFileSync(target, 'preserve', { mode: 0o600 })
  if (kind === 'symlink') symlinkSync(outside, target)
  if (kind === 'dangling symlink') symlinkSync(join(root, 'missing'), target)
  await expect(commissionBNB(certificate, target)).rejects.toThrow('no secret values')
  expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('preserve')
  expect(readdirSync(outside)).toEqual(['marker'])
  if (kind === 'directory') expect(readdirSync(target)).toEqual([])
  if (kind === 'file') expect(readFileSync(target, 'utf8')).toBe('preserve')
})

it.each(['symlink', 'directory', 'writable', 'weak RSA', 'nonstandard RSA exponent', 'private PEM header', 'invalid PEM'])('refuses %s certificate input before creating output', async (kind) => {
  const selected = join(root, 'selected.pem'), output = join(root, 'output')
  if (kind === 'symlink') symlinkSync(certificate, selected)
  else if (kind === 'directory') mkdirSync(selected, { mode: 0o700 })
  else {
    const data = kind === 'weak RSA' ? weakPublicKey : kind === 'nonstandard RSA exponent' ? otherExponentKey : kind === 'private PEM header'
      ? Buffer.from('-----BEGIN PRIVATE KEY-----\nnot-a-private-key\n-----END PRIVATE KEY-----\n')
      : kind === 'invalid PEM' ? Buffer.from('invalid public certificate') : publicKey
    writeFileSync(selected, data, { mode: kind === 'writable' ? 0o666 : 0o644 })
    if (kind === 'writable') chmodSync(selected, 0o666)
  }
  await expect(commissionBNB(selected, output)).rejects.toThrow('no secret values')
  expect(existsSync(output)).toBe(false)
})

it.each(['certificate then public key', 'public key then certificate', 'mismatched footer', 'trailing block', 'leading text', 'invalid base64'])('refuses %s instead of relying on PEM parser block selection', async (kind) => {
  const altered: Record<string, Buffer> = {
    'certificate then public key': Buffer.concat([x509Certificate, otherExponentKey]),
    'public key then certificate': Buffer.concat([publicKey, x509Certificate]),
    'mismatched footer': Buffer.from(x509Certificate.toString().replace('-----END CERTIFICATE-----', '-----END PUBLIC KEY-----')),
    'trailing block': Buffer.concat([x509Certificate, Buffer.from('-----BEGIN COMMENT-----\nYQ==\n-----END COMMENT-----\n')]),
    'leading text': Buffer.concat([Buffer.from('ignored preamble\n'), x509Certificate]),
    'invalid base64': Buffer.from('-----BEGIN PUBLIC KEY-----\nAA=A\n-----END PUBLIC KEY-----\n'),
  }
  if (kind === 'certificate then public key')
    expect(createPublicKey(altered[kind]).export({ type: 'spki', format: 'pem' }) === otherExponentKey.toString()).toBe(true)
  writeFileSync(certificate, altered[kind], { mode: 0o644 })
  const output = join(root, 'output')
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(existsSync(output)).toBe(false)
})

it.each(['relative certificate', 'relative output', 'parent symlink', 'writable parent'])('refuses %s without provisioning', async (kind) => {
  let cert = certificate, output = join(root, 'output')
  if (kind === 'relative certificate') cert = 'certificate.pem'
  if (kind === 'relative output') output = 'relative-output'
  if (kind === 'parent symlink') { symlinkSync(root, join(root, 'alias')); output = join(root, 'alias', 'output') }
  if (kind === 'writable parent') chmodSync(root, 0o777)
  try { await expect(commissionBNB(cert, output)).rejects.toThrow('no secret values') }
  finally { chmodSync(root, 0o700) }
  expect(existsSync(join(root, 'output'))).toBe(false)
})

it('refuses an already active SDK engine without stopping or modifying it', async () => {
  const db = new LevelDOWN(join(root, 'existing-engine'))
  const unavailable = async (): Promise<never> => { throw new Error('No artifacts.') }
  await startRailgunEngine('existing', db, false, new ArtifactStore(unavailable, unavailable, async () => false), false, true)
  await expect(commissionBNB(certificate, join(root, 'output'))).rejects.toThrow('no secret values')
  expect(hasEngine()).toBe(true); expect(existsSync(join(root, 'output'))).toBe(false)
})

it('keeps encrypted recovery material after an SDK failure and refuses reuse of that incomplete directory', async () => {
  const output = join(root, 'incomplete')
  const opening = vi.spyOn(LevelDOWN.prototype, 'open').mockImplementationOnce(function (...args: unknown[]) {
    const callback = args.at(-1) as (error: Error) => void
    callback(new Error('sensitive SDK diagnostic'))
  } as never)
  try { await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values') }
  finally { opening.mockRestore() }
  const files = readdirSync(output)
  expect(files).toEqual(['operator-retired.sealed.json'])
  const sealed = readFileSync(join(output, files[0])), clear = openOperator(sealed, privateKey)
  try { expect(!!parseSecrets(clear).feeMnemonic).toBe(true) } finally { clear.fill(0) }
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(readFileSync(join(output, files[0])).equals(sealed)).toBe(true)
})

it('still closes the database, removes temporary storage and syncs the directory when SDK stop fails', async () => {
  const output = join(root, 'stop-failure')
  vi.spyOn(RailgunEngine.prototype, 'unload').mockRejectedValueOnce(new Error('sensitive stop diagnostic'))
  const closed = vi.spyOn(LevelDOWN.prototype, 'close')
  const removed = vi.spyOn(fs, 'rmSync'), synced = vi.spyOn(fs, 'fsyncSync')
  syncBuiltinESMExports()
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(closed.mock.calls.length).toBe(1); expect(removed.mock.calls.length).toBe(1)
  expect(synced.mock.invocationCallOrder.some((order) => order > removed.mock.invocationCallOrder[0])).toBe(true)
  expect(readdirSync(output).sort()).toEqual(expectedFiles)
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(readdirSync(output).sort()).toEqual(expectedFiles)
})

it('attempts directory sync after temporary removal fails and preserves every final ciphertext', async () => {
  const output = join(root, 'remove-failure')
  const removed = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('sensitive removal diagnostic') })
  const synced = vi.spyOn(fs, 'fsyncSync')
  syncBuiltinESMExports()
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(synced.mock.invocationCallOrder.some((order) => order > removed.mock.invocationCallOrder[0])).toBe(true)
  expect(readdirSync(output).some((name) => name.startsWith('.commission-wallet-'))).toBe(true)
  const records = expectedFiles.map((name) => readFileSync(join(output, name)))
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(expectedFiles.every((name, index) => readFileSync(join(output, name)).equals(records[index]))).toBe(true)
})

it('removes temporary storage and syncs after the explicit database-close callback fails', async () => {
  const output = join(root, 'database-close-failure'), originalClose = LevelDOWN.prototype.close
  let calls = 0
  const closed = vi.spyOn(LevelDOWN.prototype, 'close').mockImplementation(function (this: ReturnType<typeof LevelDOWN>, callback) {
    if (++calls === 2) { (callback as (error: Error) => void)(new Error('sensitive database close diagnostic')); return }
    originalClose.call(this, callback)
  })
  const removed = vi.spyOn(fs, 'rmSync'), synced = vi.spyOn(fs, 'fsyncSync')
  syncBuiltinESMExports()
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(closed.mock.calls.length).toBe(2); expect(removed.mock.calls.length).toBe(1)
  expect(removed.mock.invocationCallOrder[0] > closed.mock.invocationCallOrder[1]).toBe(true)
  expect(synced.mock.invocationCallOrder.some((order) => order > removed.mock.invocationCallOrder[0])).toBe(true)
  expect(readdirSync(output).sort()).toEqual(expectedFiles)
  const records = expectedFiles.map((name) => readFileSync(join(output, name)))
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(expectedFiles.every((name, index) => readFileSync(join(output, name)).equals(records[index]))).toBe(true)
})

it('reports a final cleanup-directory fsync failure after removal and retains all final ciphertexts', async () => {
  const output = join(root, 'cleanup-sync-failure'), originalSync = fs.fsyncSync
  const closed = vi.spyOn(LevelDOWN.prototype, 'close'), removed = vi.spyOn(fs, 'rmSync')
  const synced = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (removed.mock.calls.length) throw new Error('sensitive cleanup sync diagnostic')
    originalSync(fd)
  })
  syncBuiltinESMExports()
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect(removed.mock.invocationCallOrder[0] > closed.mock.invocationCallOrder.at(-1)!).toBe(true)
  expect(synced.mock.invocationCallOrder.at(-1)! > removed.mock.invocationCallOrder[0]).toBe(true)
  expect(synced.mock.results.at(-1)?.type).toBe('throw')
  expect(readdirSync(output).sort()).toEqual(expectedFiles)
  const records = expectedFiles.map((name) => readFileSync(join(output, name)))
  synced.mockRestore(); removed.mockRestore(); syncBuiltinESMExports()
  await expect(commissionBNB(certificate, output)).rejects.toThrow('no secret values')
  expect((await commissionBNB(certificate, join(root, 'after-sync-failure'))).chainId).toBe(56)
  expect(expectedFiles.every((name, index) => readFileSync(join(output, name)).equals(records[index]))).toBe(true)
})
