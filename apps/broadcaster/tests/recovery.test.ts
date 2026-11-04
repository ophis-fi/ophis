import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { Store } from '../src/storage'
import { recover } from '../src/recovery'
import { NETWORK } from '../src/config'
import { config } from './request.fixture'

let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ophis-recovery-')); store = new Store(directory) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

async function fixture() {
  const wallet = new Wallet(Wallet.createRandom().privateKey)
  const raw = await wallet.signTransaction({ to: NETWORK.proxyContract, data: '0x12345678', value: 0n,
    type: 2, chainId: 1, nonce: 0, gasLimit: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })
  const hash = Transaction.from(raw).hash!
  store.signed('one', 'encrypted request', raw, hash, 200_000_000_000_000n, config.dailyBudget, 0, '{}', Date.now() + 60_000)
  const provider = {
    getBlock: vi.fn(async () => ({ number: 100, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n })),
    getBalance: vi.fn(async () => 10n ** 18n), getTransactionCount: vi.fn(async () => 0),
    getRpcTransaction: vi.fn((tx) => tx),
    send: vi.fn(async () => ({ type: 'CALL', to: NETWORK.proxyContract, input: '0x12345678' })),
  }
  const sender = { pendingTransaction: vi.fn((): { hash: string; nonce: number } | undefined => undefined),
    stageSigned: vi.fn(async () => hash), retryPending: vi.fn(async () => hash),
    cancelPending: vi.fn(async (signed: string) => Transaction.from(signed).hash!),
  }
  const sign = vi.spyOn(wallet, 'signTransaction')
  const run = (command: 'retry' | 'cancel', args: string[] = []) => recover(command, args, config, store,
    provider as unknown as JsonRpcProvider, wallet, sender)
  return { wallet, raw, hash, provider, sender, sign, run }
}

it('stages a crash-gap transaction and retries identical signed bytes without signing again', async () => {
  const f = await fixture()
  expect(await f.run('retry')).toBe(f.hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(f.raw)
  expect(f.sender.retryPending).toHaveBeenCalledOnce()
  expect(f.sign).not.toHaveBeenCalled()
})

it('blocks an original mainnet retry before any execution or disclosure', async () => {
  const f = await fixture()
  await expect(recover('retry', [], { ...config, mode: 'mainnet', enabled: false }, store,
    f.provider as unknown as JsonRpcProvider, f.wallet, f.sender)).rejects.toThrow('Unsecured mainnet sponsorship retries')
  expect(f.provider.send).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
  expect(f.sender.retryPending).not.toHaveBeenCalled()
  expect(f.sign).not.toHaveBeenCalled()
  expect(store.get('one')?.raw).toBe(f.raw)
})

it('replaces a stale transport journal only after the preceding nonce is confirmed', async () => {
  const f = await fixture()
  const original = Transaction.from(f.raw)
  const raw = await f.wallet.signTransaction({ ...original.toJSON(), nonce: 1, signature: undefined })
  const hash = Transaction.from(raw).hash!
  store.confirmed('one', 100n, Date.now())
  store.assured('one')
  store.signed('two', 'encrypted request', raw, hash, 200_000_000_000_000n, config.dailyBudget, 1, '{}', Date.now() + 60_000)
  f.sender.pendingTransaction.mockReturnValue({ hash: f.hash, nonce: 0 })
  f.provider.getTransactionCount.mockResolvedValue(1)
  await f.run('retry')
  expect(f.sender.stageSigned).toHaveBeenCalledWith(raw)
  expect(f.sender.retryPending).toHaveBeenCalledOnce()
})

it('preserves explicit mainnet cancellation and identical cancellation retry while unarmed', async () => {
  const f = await fixture()
  const unarmed = { ...config, mode: 'mainnet' as const, enabled: false }
  const hash = await recover('cancel', ['3000000000', '2000000000'], unarmed, store,
    f.provider as unknown as JsonRpcProvider, f.wallet, f.sender)
  expect(store.get('one')?.cancel_hash).toBe(hash)
  expect(await recover('retry', [], unarmed, store,
    f.provider as unknown as JsonRpcProvider, f.wallet, f.sender)).toBe(hash)
  expect(f.sign).toHaveBeenCalledOnce()
  expect(f.sender.retryPending).not.toHaveBeenCalled()
  expect(store.get('one')?.raw).toBe(f.raw)
})

it.each(['expired', 'consumed', 'underfunded', 'journal-mismatch', 'missing-private-call'])('refuses unsafe %s recovery before signing or publishing', async (reason) => {
  const f = await fixture()
  if (reason === 'expired') store.db.prepare('UPDATE requests SET fee_expiration=0').run()
  if (reason === 'consumed') f.provider.getTransactionCount.mockResolvedValue(1)
  if (reason === 'underfunded') f.provider.getBalance.mockResolvedValue(0n)
  if (reason === 'journal-mismatch') f.sender.pendingTransaction.mockReturnValue({ hash: 'different', nonce: 0 })
  if (reason === 'missing-private-call') f.provider.send.mockResolvedValue({ type: 'CALL', to: f.wallet.address, input: '0x' })
  await expect(f.run('retry')).rejects.toThrow()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
  expect(f.sender.retryPending).not.toHaveBeenCalled()
})

it('persists a bounded zero-value cancellation before private submission, preserving the original request', async () => {
  const f = await fixture()
  f.sender.cancelPending.mockImplementationOnce(async (raw) => {
    expect(store.get('one')?.cancel_raw).toBe(raw)
    expect(store.get('one')?.raw).toBe(f.raw)
    const tx = Transaction.from(raw)
    expect(tx.to).toBe(f.wallet.address); expect(tx.value).toBe(0n)
    expect(tx.gasLimit).toBe(21_000n); expect(tx.data).toBe('0x'); expect(tx.nonce).toBe(0)
    return tx.hash!
  })
  const hash = await f.run('cancel', ['3000000000', '2000000000'])
  expect(store.get('one')?.cancel_hash).toBe(hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(f.raw)
  expect(store.exposure()).toBe(200_000_000_000_000n)
})

it('enforces cancellation caps before any new signature', async () => {
  const f = await fixture()
  await expect(f.run('cancel', ['20000000000', '2000000000'])).rejects.toThrow('limits')
  expect(f.sign).not.toHaveBeenCalled()
  expect(store.get('one')?.cancel_raw).toBeNull()
})
