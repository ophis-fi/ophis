import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { sealOperator } from '../src/custody'
import { loadOwnerIdentity, openPinnedOperator, type OwnerIdentity } from '../src/owner-pins'

const runtime = { gasKey: `0x${'11'.repeat(32)}`, encryptionKey: 'aa'.repeat(32), feeViewingKey: 'ab'.repeat(80) }
const retired = { gasKey: `0x${'22'.repeat(32)}`, encryptionKey: 'bb'.repeat(32),
  feeMnemonic: 'test test test test test test test test test test test junk' }
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
let publicKey: Buffer, privateKey: Buffer, sealedRuntime: Buffer, sealedRetired: Buffer, identity: OwnerIdentity, root: string
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 })
  publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  sealedRuntime = sealOperator(Buffer.from(JSON.stringify(runtime)), publicKey)
  sealedRetired = sealOperator(Buffer.from(JSON.stringify(retired)), publicKey)
  identity = { gasWalletAddress: new Wallet(runtime.gasKey).address, runtimeSha256: hash(sealedRuntime), retiredSha256: hash(sealedRetired) }
})
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'owner-pins-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

function manifest(chains = { '1': identity } as Record<string, OwnerIdentity>) {
  const path = join(root, 'operator-identities.json')
  writeFileSync(path, JSON.stringify({ version: 1, chains }), { mode: 0o600 })
  return path
}

it.each(['1', '42161', '56', '137'])('loads owner-held pins for supported chain %s beside the supplied recovery key', (chain) => {
  manifest({ [chain]: identity })
  expect(loadOwnerIdentity(join(root, 'restore-key.pem'), chain)).toEqual(identity)
})

it.each(['version', 'unknown chain', 'missing selected chain', 'missing hash', 'invalid hash', 'extra field', 'zero address'])(
  'rejects %s identity manifests', (condition) => {
    const value = { version: 1, chains: { '1': { ...identity } } as Record<string, Partial<OwnerIdentity>> }
    if (condition === 'version') value.version = 2
    if (condition === 'unknown chain') value.chains['999999'] = identity
    if (condition === 'missing selected chain') value.chains = {}
    if (condition === 'missing hash') delete value.chains['1'].runtimeSha256
    if (condition === 'invalid hash') value.chains['1'].retiredSha256 = 'not-a-sha256-hash'
    if (condition === 'extra field') Object.assign(value.chains['1'], { serverMetadata: true })
    if (condition === 'zero address') value.chains['1'].gasWalletAddress = `0x${'00'.repeat(20)}`
    writeFileSync(join(root, 'operator-identities.json'), JSON.stringify(value), { mode: 0o600 })
    expect(() => loadOwnerIdentity(join(root, 'restore-key.pem'), '1')).toThrow()
  },
)

it.each([0o644, 0o640, 0o400])('rejects owner pins with permissions %i instead of 0600', (mode) => {
  const path = manifest(); chmodSync(path, mode)
  expect(() => loadOwnerIdentity(join(root, 'restore-key.pem'), '1')).toThrow('0600')
})

it('rejects a symlink or directory in place of the manifest', () => {
  const path = manifest()
  const alias = join(root, 'alias'); mkdirSync(alias, { mode: 0o700 })
  symlinkSync(path, join(alias, 'operator-identities.json'))
  expect(() => loadOwnerIdentity(join(alias, 'restore-key.pem'), '1')).toThrow()
  const directory = join(root, 'dir'); mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, 'operator-identities.json'), { mode: 0o600 })
  expect(() => loadOwnerIdentity(join(directory, 'restore-key.pem'), '1')).toThrow()
})

it.each(['directory', 'manifest'])('rejects an owner identity %s owned by another UID', (condition) => {
  manifest()
  const uid = process.getuid!()
  const getuid = vi.spyOn(process, 'getuid')
  if (condition === 'manifest') getuid.mockReturnValueOnce(uid)
  getuid.mockReturnValue(uid + 1)
  expect(() => loadOwnerIdentity(join(root, 'restore-key.pem'), '1')).toThrow('owned')
})

it('requires an owned private parent directory and rejects a parent symlink', () => {
  manifest(); chmodSync(root, 0o755)
  expect(() => loadOwnerIdentity(join(root, 'restore-key.pem'), '1')).toThrow('0700')
  chmodSync(root, 0o700)
  const real = join(root, 'real'); mkdirSync(real, { mode: 0o700 })
  writeFileSync(join(real, 'operator-identities.json'), JSON.stringify({ version: 1, chains: { '1': identity } }), { mode: 0o600 })
  const alias = join(root, 'parent-link'); symlinkSync(real, alias)
  expect(() => loadOwnerIdentity(join(alias, 'restore-key.pem'), '1')).toThrow()
})

it('accepts existing version-one ciphertext only for its pinned runtime or retired role', () => {
  for (const [sealed, role, expected] of [[sealedRuntime, 'runtime', runtime], [sealedRetired, 'retired', retired]] as const) {
    const clear = openPinnedOperator(sealed, privateKey, identity, role)
    try { expect(JSON.parse(clear.toString())).toEqual(expected) } finally { clear.fill(0) }
  }
})

it('checks ciphertext origin and role pins before parsing any recovery key', () => {
  expect(() => openPinnedOperator(sealedRetired, Buffer.from('not a private key'), identity, 'runtime')).toThrow('owner pin')
  const forged = sealOperator(Buffer.from(JSON.stringify(runtime)), publicKey)
  expect(() => openPinnedOperator(forged, Buffer.from('not a private key'), identity, 'runtime')).toThrow('owner pin')
})

it('checks the retired role pin before decrypting a runtime substitution', () => {
  expect(() => openPinnedOperator(sealedRuntime, Buffer.from('not a private key'), identity, 'retired')).toThrow('owner pin')
})

it.each(['wrong gas wallet', 'retired mnemonic', 'extra mnemonic', 'extra field'])(
  'rejects a pinned runtime payload containing %s', (condition) => {
    let payload = { ...runtime } as Record<string, unknown>
    if (condition === 'wrong gas wallet') payload.gasKey = retired.gasKey
    if (condition === 'retired mnemonic') payload = { ...retired }
    if (condition === 'extra mnemonic') payload.feeMnemonic = retired.feeMnemonic
    if (condition === 'extra field') payload.mnemonic = retired.feeMnemonic
    const sealed = sealOperator(Buffer.from(JSON.stringify(payload)), publicKey)
    expect(() => openPinnedOperator(sealed, privateKey, { ...identity, runtimeSha256: hash(sealed) }, 'runtime')).toThrow('role and identity')
  },
)

it.each(['runtime', 'invalid mnemonic'])('rejects %s material even when pinned for the retired role', (condition) => {
  const payload = condition === 'runtime' ? runtime : { ...retired, feeMnemonic: 'dummy invalid phrase' }
  const sealed = sealOperator(Buffer.from(JSON.stringify(payload)), publicKey)
  expect(() => openPinnedOperator(sealed, privateKey, { ...identity, retiredSha256: hash(sealed) }, 'retired')).toThrow('role and identity')
})
