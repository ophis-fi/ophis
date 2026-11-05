import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Transaction, Wallet, ZeroAddress } from 'ethers'
import { Store } from '../src/storage'

let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ophis-journal-identity-')); store = new Store(directory) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

async function signed(chainId = 1, wallet = Wallet.createRandom(), nonce = 0) {
  const raw = await wallet.signTransaction({ chainId, type: 2, nonce, to: wallet.address, value: 0n,
    gasLimit: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })
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
