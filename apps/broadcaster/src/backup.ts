import { existsSync, lstatSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { privateDirectory, privateFile } from './storage'

export async function snapshotCriticalState(state: string, destination: string): Promise<void> {
  const target = resolve(destination)
  if (!target.startsWith(resolve(state) + sep + '.backup-snapshot.')) throw new Error('Use a private snapshot directory inside operator state.')
  privateDirectory(target)
  const root = join(target, 'state'), secrets = join(root, 'secrets')
  privateDirectory(root); privateDirectory(secrets)
  // Owner custody keeps separate sealed gas/fee records; legacy custody retains its original required files.
  const custodyFiles = lstatSync(join(state, 'secrets', 'owner-manifest.json'), { throwIfNoEntry: false })
    ? ['owner-manifest.json', 'operator.sealed.json', 'fee-wallet-public.json', 'fee-wallet.sealed.json']
    : ['operator.sealed.json', 'operator-retired.sealed.json', 'operator-public.json', 'backup-cert.pem']
  for (const name of custodyFiles)
    writeFileSync(join(secrets, name), privateFile(join(state, 'secrets', name)), { flag: 'wx', mode: 0o600 })
  for (const name of ['guard-deployment-approval.json', 'guard-deployment-signed.json', 'guard-deployment-receipt.json'])
    if (existsSync(join(state, name))) writeFileSync(join(root, name), privateFile(join(state, name)), { flag: 'wx', mode: 0o600 })
  // Transport first: every disclosed transaction was already recorded in requests.
  for (const name of ['protected-transactions.sqlite', 'requests.sqlite']) {
    const source = join(state, name)
    if (!existsSync(source)) { if (name === 'requests.sqlite') throw new Error('Missing request journal.'); continue }
    privateFile(source, true)
    const database = new DatabaseSync(source, { readOnly: true })
    const path = join(root, name)
    privateFile(path, true)
    try { await backup(database, path) } finally { database.close() }
  }
  const requests = new DatabaseSync(join(root, 'requests.sqlite'))
  try {
    requests.prepare('DELETE FROM settings WHERE key=?').run('walletId')
    if (requests.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get())
      requests.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('creditRecoveryRequired', '1')
  } finally { requests.close() }
  writeFileSync(join(root, 'backup-kind.json'), JSON.stringify({ kind: 'critical-state', walletHistoryMustResync: true }), { flag: 'wx', mode: 0o600 })
}
