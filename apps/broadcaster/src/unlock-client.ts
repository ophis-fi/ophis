import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openOperator } from './custody'

// This client runs on the owner's Mac. Only encrypted files cross back from Baal.
const mode = process.argv[2] ?? 'unlock'
if (!['unlock', 'recovery', 'verify', 'verify-retired'].includes(mode)) {
  console.error('Use unlock, recovery, verify or verify-retired.'); process.exit(1)
}
const base = '/home/clement/.local/share/ophis-broadcaster'
const ssh = (command: string, input?: Buffer) => {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes',
    'clement@100.69.134.7', command], { input, timeout: 30_000, maxBuffer: 64 * 1024 })
  if (result.status !== 0 || result.error) throw new Error('Authenticated operator connection failed.')
  return result.stdout
}
let recovery: Buffer | undefined, clear: Buffer | undefined
try {
  const path = process.argv[3] ?? join(homedir(), '.local/share/ophis-broadcaster-backup-key/restore-key.pem')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16 * 1024)
      throw new Error('The off-server recovery key must be an owned private regular file.')
    recovery = readFileSync(fd)
  } finally { closeSync(fd) }
  const file = mode === 'verify-retired' ? 'operator-retired.sealed.json' : 'operator.sealed.json'
  const sealed = ssh(`cat '${base}/state/secrets/${file}'`)
  clear = openOperator(sealed, recovery)
  if (mode === 'verify' || mode === 'verify-retired') console.log(JSON.stringify({ status: 'verified', file }))
  else {
    const container = mode === 'recovery' ? 'ophis-broadcaster-recovery' : 'ophis-broadcaster-broadcaster-1'
    const reply = ssh(`docker exec -i ${container} node dist/main.mjs unlock`, clear)
    if (reply.toString().trim() !== '{"status":"unlocked"}') throw new Error('Unexpected unlock acknowledgment.')
    console.log(JSON.stringify({ status: 'unlocked', container }))
  }
} catch {
  console.error('Operator unlock/verification failed. No secret values were logged.'); process.exitCode = 1
} finally { clear?.fill(0); recovery?.fill(0) }
