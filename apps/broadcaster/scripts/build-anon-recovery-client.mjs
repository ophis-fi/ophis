import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ORIGINAL_OWNER_HELPER_SHA256 = '8c6f7a58aa4df0776e8f52aa7bed7505f0091881d6eef38b7ed422d8b217c364'
export function recoveryClient(source) {
  if (createHash('sha256').update(source).digest('hex') !== ORIGINAL_OWNER_HELPER_SHA256) throw Error('Unreviewed original owner helper.')
  const prefix = source.slice(0, source.indexOf('async function main() {'))
  if (!prefix || prefix === source) throw Error('Missing original main boundary.')
  const profile = readFileSync(fileURLToPath(new URL('./anon-recovery.mjs', import.meta.url)), 'utf8')
    .split('// BEGIN SHARED RECOVERY PROFILE')[1].split('\n').slice(1).join('\n').split('// END SHARED RECOVERY PROFILE')[0].replaceAll('export function ', 'function ')
  const main = readFileSync(fileURLToPath(new URL('./anon-recovery-owner-main.txt', import.meta.url)), 'utf8')
  return prefix + profile + main
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw Error('Provide original helper and new output path.')
    const output = recoveryClient(readFileSync(process.argv[2], 'utf8'))
    writeFileSync(process.argv[3], output, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ status: 'recovery-client-created', sha256: createHash('sha256').update(output).digest('hex') }))
  } catch { console.error('Recovery client build failed; no existing helper was changed.'); process.exitCode = 1 }
}
