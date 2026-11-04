import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { snapshotCriticalState } from '../src/backup'
import { privateDirectory, privateFile, Store } from '../src/storage'

it('snapshots live WAL journals and encrypted keys without stopping the operator or losing unknown transactions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'critical-backup-'))
  privateDirectory(join(root, 'secrets'))
  for (const name of ['operator.sealed.json', 'operator-retired.sealed.json', 'operator-public.json', 'backup-cert.pem'])
    writeFileSync(join(root, 'secrets', name), 'encrypted/dummy-public-data', { mode: 0o600 })
  const store = new Store(root)
  privateFile(join(root, 'protected-transactions.sqlite'), true)
  const transport = new DatabaseSync(join(root, 'protected-transactions.sqlite'))
  try {
    transport.exec('PRAGMA journal_mode=WAL; CREATE TABLE pending (raw TEXT); INSERT INTO pending VALUES (\'unknown signed bytes\')')
    store.signed('pending', 'encrypted request', 'unknown signed bytes', 'hash', 100n, 1000n, 0)
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('walletId', 'live-view-id')
    const destination = join(root, '.backup-snapshot.test')
    await snapshotCriticalState(root, destination)
    const saved = new Store(join(destination, 'state'))
    const savedTransport = new DatabaseSync(join(destination, 'state', 'protected-transactions.sqlite'))
    try {
      expect(saved.get('pending')?.raw).toBe('unknown signed bytes')
      expect(saved.exposure()).toBe(100n)
      expect(savedTransport.prepare('SELECT raw FROM pending').get()?.raw).toBe('unknown signed bytes')
      expect(saved.db.prepare('SELECT value FROM settings WHERE key=?').get('walletId')).toBeUndefined()
      expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('walletId')?.value).toBe('live-view-id')
      expect(readFileSync(join(destination, 'state', 'secrets', 'operator.sealed.json'), 'utf8')).toBe('encrypted/dummy-public-data')
      store.confirmed('pending', 80n, Date.now())
      expect(store.exposure()).toBe(80n)
      expect(saved.exposure()).toBe(100n)
    } finally { saved.close(); savedTransport.close() }
    await expect(snapshotCriticalState(root, join(root, 'outside'))).rejects.toThrow('private snapshot')
  } finally { store.close(); transport.close(); rmSync(root, { recursive: true, force: true }) }
})
