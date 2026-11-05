import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Transaction, Wallet, ZeroAddress } from 'ethers'
import { Store } from '../src/storage'

let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ophis-journal-identity-')); store = new Store(directory) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

async function signed(chainId = 1, wallet = Wallet.createRandom(), nonce = 0, maxFeePerGas = 2n) {
  const raw = await wallet.signTransaction({ chainId, type: 2, nonce, to: wallet.address, value: 0n,
    gasLimit: 21_000n, maxFeePerGas, maxPriorityFeePerGas: 1n })
  return { raw, hash: Transaction.from(raw).hash!, wallet }
}

it.each([1, 42161, 56, 137])('binds an empty chain %i journal and rejects another chain or operator after reopen', (chainId) => {
  const operator = Wallet.createRandom().address
  store.bindIdentity(chainId, operator.toLowerCase())
  store.close(); store = new Store(directory)
  expect(() => store.bindIdentity(chainId, operator)).not.toThrow()
  expect(() => store.bindIdentity(chainId)).not.toThrow()
  expect(() => store.bindIdentity(chainId === 1 ? 56 : 1, operator)).toThrow('different network or gas wallet')
  expect(() => store.bindIdentity(chainId, Wallet.createRandom().address)).toThrow('different network or gas wallet')
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('operatorAddress')?.value).toBe(operator)
})

it('validates and preserves historical Ethereum requests, cancellation, fees and the used pilot marker', async () => {
  const original = await signed(), cancellation = await signed(1, original.wallet)
  store.signed('saved', 'encrypted-envelope', original.raw, original.hash, 42_000n, 100_000n, 0, '{}', 1234, true)
  store.cancel('saved', cancellation.raw, cancellation.hash, 42_000n, 100_000n)
  store.respond('saved', 'encrypted-response')
  store.db.prepare('INSERT INTO fees VALUES(?,?,?)').run('quote', 1234, '{}')
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run('walletId', 'existing-wallet')
  const before = store.get('saved')
  store.bindIdentity(1, original.wallet.address)
  expect(store.get('saved')).toEqual(before)
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe(original.hash)
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('walletId')?.value).toBe('existing-wallet')
  expect(store.db.prepare('SELECT id FROM fees').get()?.id).toBe('quote')
  store.close(); store = new Store(directory)
  expect(() => store.bindIdentity(1, original.wallet.address)).not.toThrow()
  expect(store.get('saved')).toEqual(before)
})

it('infers the legacy Ethereum operator and permits an empty chain-only identity to acquire its operator once', async () => {
  store.bindIdentity(1)
  const original = await signed()
  store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 100_000n, 0)
  store.bindIdentity(1)
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('operatorAddress')?.value).toBe(original.wallet.address)
  expect(() => store.bindIdentity(1, Wallet.createRandom().address)).toThrow('different network or gas wallet')
})

it.each(['requests', 'fees', 'wallet', 'pilot', 'resolution'])('refuses populated unbound non-Ethereum state containing %s', async (kind) => {
  if (kind === 'requests') {
    const original = await signed(56)
    store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 100_000n, 0)
  } else if (kind === 'fees') store.db.prepare('INSERT INTO fees VALUES(?,?,?)').run('quote', 1234, '{}')
  else if (kind === 'resolution') store.db.prepare('INSERT INTO settlement_resolutions VALUES(?,?,?,?,?,?,?)')
    .run('saved', 'hash', '1', 1, 'block', 'Historical resolution', 1)
  else store.db.prepare('INSERT INTO settings VALUES(?,?)').run(kind === 'wallet' ? 'walletId' : 'withdrawalPilot', 'saved')
  expect(() => store.bindIdentity(56, Wallet.createRandom().address)).toThrow('legacy journal')
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('chainId')).toBeUndefined()
})

it.each(['chain', 'operator', 'hash', 'nonce', 'unsigned', 'missing', 'cancel-chain', 'cancel-operator', 'cancel-hash', 'cancel-missing'])(
  'rejects inconsistent legacy %s without partially binding the journal', async (kind) => {
    const original = await signed()
    store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 100_000n, 0)
    if (kind === 'chain' || kind === 'operator') {
      const wrong = await signed(kind === 'chain' ? 56 : 1, kind === 'operator' ? Wallet.createRandom() : original.wallet)
      store.db.prepare('UPDATE requests SET raw=?,hash=?').run(wrong.raw, wrong.hash)
    } else if (kind.startsWith('cancel-')) {
      const wrong = await signed(kind === 'cancel-chain' ? 56 : 1,
        kind === 'cancel-operator' ? Wallet.createRandom() : original.wallet)
      store.db.prepare('UPDATE requests SET cancel_raw=?,cancel_hash=?')
        .run(kind === 'cancel-missing' ? null : wrong.raw, kind === 'cancel-hash' ? 'wrong-hash' : wrong.hash)
    } else if (kind === 'hash') store.db.prepare('UPDATE requests SET hash=?').run('wrong-hash')
    else if (kind === 'nonce') store.db.prepare('UPDATE requests SET nonce=1').run()
    else if (kind === 'missing') store.db.prepare('UPDATE requests SET raw=NULL,hash=NULL').run()
    else store.db.prepare('UPDATE requests SET raw=?').run(Transaction.from(original.raw).unsignedSerialized)
    expect(() => store.bindIdentity(1, original.wallet.address)).toThrow('signed transaction')
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('chainId')).toBeUndefined()
    expect(store.get('saved')).toBeDefined()
  },
)

it.each([['chainId', '01'], ['chainId', '8453'], ['chainId', 'not-a-chain'], ['operatorAddress', 'not-an-address']])(
  'rejects corrupt or partial binding %s=%s', (key, value) => {
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run(key, value)
    expect(() => store.bindIdentity(1)).toThrow()
  },
)

it('prevents identity updates, deletes and replacements without restricting other settings', () => {
  store.bindIdentity(1, Wallet.createRandom().address)
  for (const sql of ["UPDATE settings SET value='56' WHERE key='chainId'", "DELETE FROM settings WHERE key='chainId'",
    "INSERT OR REPLACE INTO settings VALUES('chainId','56')", "UPDATE settings SET key='walletId' WHERE key='operatorAddress'"])
    expect(() => store.db.exec(sql)).toThrow('immutable')
  expect(() => store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('walletId', 'normal')).not.toThrow()
  expect(() => store.bindIdentity(8453)).toThrow('Unsupported')
  expect(() => store.bindIdentity(1, ZeroAddress)).toThrow('Invalid operator')
})

it.each([1, 56])('retains every chain %i cancellation through replacement, exact retries, restart and settlement', async (chainId) => {
  const original = await signed(chainId), first = await signed(chainId, original.wallet, 0, 3n)
  const latest = await signed(chainId, original.wallet, 0, 4n)
  store.bindIdentity(chainId, original.wallet.address)
  store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 1_000_000n, 0)
  store.cancel('saved', first.raw, first.hash, 63_000n, 1_000_000n)
  store.cancel('saved', latest.raw, latest.hash, 84_000n, 1_000_000n)
  store.cancel('saved', latest.raw, latest.hash, 84_000n, 1_000_000n)
  const expected = [{ hash: latest.hash, raw: latest.raw, nonce: 0 }, { hash: first.hash, raw: first.raw, nonce: 0 }]
  expect(store.cancellations('saved')).toEqual(expected)
  expect(() => store.cancel('saved', first.raw, first.hash, 63_000n, 1_000_000n)).toThrow('earlier cancellation')
  expect(() => store.cancel('saved', 'changed raw', latest.hash, 84_000n, 1_000_000n)).toThrow('inconsistent')
  store.close(); store = new Store(directory)
  store.bindIdentity(chainId, original.wallet.address)
  expect(store.get('saved')?.cancel_raw).toBe(latest.raw)
  expect(store.cancellations('saved')).toEqual(expected)
  store.confirmed('saved', 63_000n, Date.now()); store.assured('saved')
  expect(store.cancellations('saved')).toEqual(expected)
  expect(() => store.signed('replay', 'envelope', original.raw, original.hash, 42_000n, 1_000_000n, 0)).toThrow('already reserved')
  for (const sql of ['UPDATE cancellation_history SET raw=\'changed\'', 'DELETE FROM cancellation_history',
    'INSERT OR REPLACE INTO cancellation_history SELECT * FROM cancellation_history LIMIT 1'])
    expect(() => store.db.exec(sql)).toThrow('append-only')
  expect(store.cancellations('saved')).toEqual(expected)
})

it('backfills the current cancellation from a legacy journal without changing its request', async () => {
  const original = await signed(), cancellation = await signed(1, original.wallet, 0, 3n)
  store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 100_000n, 0)
  store.db.prepare('UPDATE requests SET cancel_raw=?,cancel_hash=?').run(cancellation.raw, cancellation.hash)
  store.db.exec('DROP TABLE cancellation_history')
  const before = store.get('saved')
  store.close(); store = new Store(directory)
  store.bindIdentity(1, original.wallet.address)
  expect(store.get('saved')).toEqual(before)
  expect(store.cancellations('saved')).toEqual([{ hash: cancellation.hash, raw: cancellation.raw, nonce: 0 }])
})

it.each(['chain', 'operator', 'nonce', 'hash', 'unsigned'])(
  'validates a retained older cancellation with wrong %s even when the latest cancellation is valid', async (kind) => {
    const original = await signed()
    const older = await signed(kind === 'chain' ? 56 : 1, kind === 'operator' ? Wallet.createRandom() : original.wallet,
      kind === 'nonce' ? 1 : 0, 3n)
    const latest = await signed(1, original.wallet, 0, 4n)
    store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 1_000_000n, 0)
    store.cancel('saved', kind === 'unsigned' ? Transaction.from(older.raw).unsignedSerialized : older.raw,
      kind === 'hash' ? 'wrong-hash' : older.hash, 63_000n, 1_000_000n)
    store.cancel('saved', latest.raw, latest.hash, 84_000n, 1_000_000n)
    store.close(); store = new Store(directory)
    expect(() => store.bindIdentity(1, original.wallet.address)).toThrow('signed transaction')
    expect(store.get('saved')?.cancel_hash).toBe(latest.hash)
    expect(store.cancellations('saved')).toHaveLength(2)
  },
)

it.each(['raw-only', 'hash-only', 'history-nonce', 'history-raw', 'orphan'])(
  'fails cancellation queries closed for %s corruption', async (kind) => {
    const original = await signed(), cancellation = await signed(1, original.wallet, 0, 3n)
    store.signed('saved', 'envelope', original.raw, original.hash, 42_000n, 100_000n, 0)
    if (kind === 'raw-only' || kind === 'hash-only') store.db.prepare('UPDATE requests SET cancel_raw=?,cancel_hash=?')
      .run(kind === 'raw-only' ? cancellation.raw : null, kind === 'hash-only' ? cancellation.hash : null)
    else {
      store.db.prepare('UPDATE requests SET cancel_raw=?,cancel_hash=?').run(cancellation.raw, cancellation.hash)
      store.db.prepare('INSERT INTO cancellation_history(key,hash,raw,nonce) VALUES(?,?,?,?)')
        .run(kind === 'orphan' ? 'missing' : 'saved', cancellation.hash, kind === 'history-raw' ? 'changed' : cancellation.raw,
          kind === 'history-nonce' ? 1 : 0)
    }
    expect(() => store.cancellations(kind === 'orphan' ? 'missing' : 'saved')).toThrow(/incomplete|inconsistent/)
    expect(() => store.bindIdentity(1, original.wallet.address)).toThrow('signed transaction')
  },
)
