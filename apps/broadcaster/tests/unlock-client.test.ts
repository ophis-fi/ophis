import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Wallet } from 'ethers'
import { sealOperator } from '../src/custody'
import type { OwnerIdentity } from '../src/owner-pins'

const runtime = { gasKey: `0x${'11'.repeat(32)}`, encryptionKey: 'aa'.repeat(32), feeViewingKey: 'ab'.repeat(80) }
const retired = { gasKey: `0x${'22'.repeat(32)}`, encryptionKey: 'bb'.repeat(32),
  feeMnemonic: 'test test test test test test test test test test test junk' }
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
let directory: string, target: string, publicKey: Buffer, privateKey: Buffer, sealedRuntime: Buffer, sealedRetired: Buffer, identity: OwnerIdentity
const fixtures: string[] = []
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-owner-client-'))
  target = join(directory, 'unlock-client.mjs')
  const built = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/build-owner-client.mjs', import.meta.url)), target],
    { timeout: 10_000, encoding: 'utf8' })
  expect(built.status).toBe(0)
  expect(existsSync(join(directory, 'node_modules'))).toBe(false)
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 })
  publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  sealedRuntime = sealOperator(Buffer.from(JSON.stringify(runtime)), publicKey)
  sealedRetired = sealOperator(Buffer.from(JSON.stringify(retired)), publicKey)
  identity = { gasWalletAddress: new Wallet(runtime.gasKey).address, runtimeSha256: hash(sealedRuntime), retiredSha256: hash(sealedRetired) }
})
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }) })
afterAll(() => { rmSync(directory, { recursive: true, force: true }); privateKey?.fill(0) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-unlock-')); fixtures.push(root)
  const key = join(root, 'restore-key.pem'), sealed = join(root, 'remote.sealed.json')
  const log = join(root, 'ssh.log'), uploaded = join(root, 'uploaded.json'), bin = join(root, 'bin')
  mkdirSync(bin, { mode: 0o700 })
  writeFileSync(key, privateKey, { mode: 0o600 }); writeFileSync(sealed, sealedRuntime, { mode: 0o600 })
  // The process can invoke only this dummy SSH executable; no production connection is possible.
  writeFileSync(join(bin, 'ssh'), `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv.at(-1);
if (command.startsWith('cat ')) {
  const chain = process.env.OPHIS_BROADCASTER_CHAIN_ID;
  const instance = chain === '1' ? 'ophis-broadcaster' : 'ophis-broadcaster-' + chain;
  const retired = ['verify-retired', 'fee-phrase'].includes(process.env.OPHIS_TEST_MODE);
  const file = retired ? 'operator-retired.sealed.json' : 'operator.sealed.json';
  if (command !== "cat '/home/clement/.local/share/" + instance + "/state/secrets/" + file + "'") process.exit(3);
  fs.appendFileSync(process.env.OPHIS_TEST_SSH_LOG, 'download\\n');
  process.stdout.write(fs.readFileSync(process.env.OPHIS_TEST_SEALED));
} else if (command.startsWith('docker exec ')) {
  fs.appendFileSync(process.env.OPHIS_TEST_SSH_LOG, 'upload\\n');
  fs.writeFileSync(process.env.OPHIS_TEST_UPLOAD, fs.readFileSync(0));
  process.stdout.write('{"status":"unlocked"}\\n');
} else process.exit(2);
`, { mode: 0o700 })
  const pins = (chains: Record<string, OwnerIdentity> = { '1': identity }) => writeFileSync(join(root, 'operator-identities.json'),
    JSON.stringify({ version: 1, chains }), { mode: 0o600 })
  pins()
  const run = (mode = 'unlock', chainId = '1') => spawnSync(process.execPath, [target, mode, key], {
    timeout: 5000, encoding: 'utf8', env: { PATH: bin, OPHIS_BROADCASTER_CHAIN_ID: chainId,
      OPHIS_TEST_MODE: mode, OPHIS_TEST_SSH_LOG: log, OPHIS_TEST_SEALED: sealed, OPHIS_TEST_UPLOAD: uploaded },
  })
  return { root, key, sealed, uploaded, pins, run, calls: () => existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

function rejected(result: ReturnType<ReturnType<typeof fixture>['run']>) {
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('No secret values were logged')
  for (const secret of [runtime.gasKey, runtime.feeViewingKey, retired.feeMnemonic]) expect(result.stderr).not.toContain(secret)
}

it('refuses fee-phrase recovery in a pipe before reading a key or connecting to the operator', () => {
  const result = spawnSync(process.execPath, [target, 'fee-phrase', '/nonexistent/key-must-not-be-opened'],
    { input: 'SHOW FEE PHRASE\n', timeout: 3000, encoding: 'utf8', env: { PATH: '/nonexistent' } })
  rejected(result)
  expect(result.stderr).not.toContain('/nonexistent')
})

it.each(['missing manifest', 'unprovisioned chain'])('requires %s owner pins before SSH or decryption', (condition) => {
  const f = fixture()
  if (condition === 'missing manifest') rmSync(join(f.root, 'operator-identities.json'))
  rejected(f.run('unlock', condition === 'unprovisioned chain' ? '42161' : '1'))
  expect(f.calls()).toBe('')
  expect(existsSync(f.uploaded)).toBe(false)
})

it.each(['retired replay', 'forged ciphertext', 'other chain'])('rejects %s before returning any plaintext', (condition) => {
  const f = fixture()
  if (condition === 'retired replay') writeFileSync(f.sealed, sealedRetired)
  if (condition === 'forged ciphertext') writeFileSync(f.sealed, sealOperator(Buffer.from(JSON.stringify(runtime)), publicKey))
  if (condition === 'other chain') {
    const other = sealOperator(Buffer.from(JSON.stringify({ ...runtime, encryptionKey: 'cc'.repeat(32) })), publicKey)
    f.pins({ '1': identity, '56': { ...identity, runtimeSha256: hash(other) } })
  }
  rejected(f.run('unlock', condition === 'other chain' ? '56' : '1'))
  expect(f.calls()).toBe('download\n')
  expect(existsSync(f.uploaded)).toBe(false)
})

it.each(['wrong gas wallet', 'mnemonic in runtime', 'retired under runtime pin', 'invalid runtime verification'])(
  'rejects %s after decryption without sending it', (condition) => {
    const f = fixture()
    const payload = condition === 'wrong gas wallet' ? { ...runtime, gasKey: retired.gasKey }
      : condition === 'mnemonic in runtime' ? { ...runtime, feeMnemonic: retired.feeMnemonic } : retired
    const sealed = sealOperator(Buffer.from(JSON.stringify(payload)), publicKey)
    writeFileSync(f.sealed, sealed); f.pins({ '1': { ...identity, runtimeSha256: hash(sealed) } })
    rejected(f.run(condition === 'invalid runtime verification' ? 'verify' : 'unlock'))
    expect(f.calls()).toBe('download\n')
    expect(existsSync(f.uploaded)).toBe(false)
  },
)

it.each(['unlock', 'recovery', 'verify', 'verify-retired'])('preserves the pinned legacy %s workflow and original state path', (mode) => {
  const f = fixture()
  if (mode === 'verify-retired') writeFileSync(f.sealed, sealedRetired)
  const result = f.run(mode)
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  const sending = mode === 'unlock' || mode === 'recovery'
  expect(JSON.parse(result.stdout).status).toBe(sending ? 'unlocked' : 'verified')
  expect(f.calls()).toBe(sending ? 'download\nupload\n' : 'download\n')
  if (sending) expect(JSON.parse(readFileSync(f.uploaded, 'utf8'))).toEqual(runtime)
  else expect(existsSync(f.uploaded)).toBe(false)
  for (const secret of [runtime.gasKey, runtime.feeViewingKey, retired.feeMnemonic]) expect(result.stdout).not.toContain(secret)
})
