import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline/promises'
import { loadOwnerIdentity, openPinnedOperator } from './owner-pins'

// Legacy commissioning client: state/ and operator-identities.json retain their original pins.
// Current ANON owner-state uses the separately reviewed baal-owner helper and owner manifest.
// Do not repoint this client's path or pins to substitute for that custody workflow.
// This client runs on the owner's Mac. Only encrypted files cross back from Baal.
const mode = process.argv[2] ?? 'unlock'
if (!['unlock', 'recovery', 'verify', 'verify-retired', 'fee-phrase'].includes(mode)) {
  console.error('Use unlock, recovery, verify, verify-retired or fee-phrase.'); process.exit(1)
}
const chainId = process.env.OPHIS_BROADCASTER_CHAIN_ID ?? '1'
const instance = ({ 1: 'ophis-broadcaster', 42161: 'ophis-broadcaster-42161',
  56: 'ophis-broadcaster-56', 137: 'ophis-broadcaster-137' } as Record<string, string>)[chainId]
if (!instance) { console.error('Unsupported operator chain. No secret values were logged.'); process.exit(1) }
const base = `/home/clement/.local/share/${instance}`
const ssh = (command: string, input?: Buffer) => {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes',
    'clement@100.69.134.7', command], { input, timeout: 30_000, maxBuffer: 64 * 1024 })
  if (result.status !== 0 || result.error) throw new Error('Authenticated operator connection failed.')
  return result.stdout
}
let recovery: Buffer | undefined, clear: Buffer | undefined
let prompt: Interface | undefined, displayed = false
const abort = new AbortController()
const interrupt = () => abort.abort()
try {
  if (mode === 'fee-phrase') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Fee recovery requires the owner’s interactive terminal.')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    process.once('SIGHUP', interrupt)
    prompt = createInterface({ input: process.stdin, output: process.stdout })
    prompt.on('SIGINT', interrupt)
    const answer = await prompt.question('Use a private terminal with screen sharing and recording off. Type SHOW FEE PHRASE to display only the dedicated fee-wallet phrase: ',
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]) })
    if (answer !== 'SHOW FEE PHRASE') throw new Error('Fee recovery cancelled.')
  }
  const path = process.argv[3] ?? join(homedir(), '.local/share/ophis-broadcaster-backup-key/restore-key.pem')
  const identity = loadOwnerIdentity(path, chainId)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16 * 1024)
      throw new Error('The off-server recovery key must be an owned private regular file.')
    recovery = readFileSync(fd)
  } finally { closeSync(fd) }
  const role = mode === 'verify-retired' || mode === 'fee-phrase' ? 'retired' : 'runtime'
  const file = role === 'retired' ? 'operator-retired.sealed.json' : 'operator.sealed.json'
  const sealed = ssh(`cat '${base}/state/secrets/${file}'`)
  clear = openPinnedOperator(sealed, recovery, identity, role)
  if (mode === 'fee-phrase') {
    const phrase: unknown = JSON.parse(clear.toString()).feeMnemonic
    if (typeof phrase !== 'string' || !/^(?:[a-z]+ ){11}[a-z]+$|^(?:[a-z]+ ){23}[a-z]+$/.test(phrase)) throw new Error('Fee recovery material is unavailable.')
    displayed = true
    process.stdout.write(`\x1b[?1049h\x1b[2J\x1b[HDedicated Ophis fee-wallet recovery phrase — keep offline:\n\n${phrase}\n\nRestore it only in a separate private-wallet browser profile. Never enter a Ledger phrase.\n`)
    await prompt!.question('Press Enter to clear this screen. ', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]) })
  } else if (mode === 'verify' || mode === 'verify-retired') console.log(JSON.stringify({ status: 'verified', file }))
  else {
    const container = mode === 'recovery' ? `${instance}-recovery` : `${instance}-broadcaster-1`
    const reply = ssh(`docker exec -i ${container} node dist/main.mjs unlock`, clear)
    if (reply.toString().trim() !== '{"status":"unlocked"}') throw new Error('Unexpected unlock acknowledgment.')
    console.log(JSON.stringify({ status: 'unlocked', container }))
  }
} catch {
  console.error('Operator unlock/verification failed. No secret values were logged.'); process.exitCode = 1
} finally {
  if (displayed) process.stdout.write('\x1b[2J\x1b[H\x1b[?1049l')
  prompt?.close()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt)
  clear?.fill(0); recovery?.fill(0)
}
