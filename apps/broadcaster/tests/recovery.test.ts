import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { Store } from '../src/storage'
import { config } from './request.fixture'

let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ophis-recovery-')); store = new Store(directory) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

async function fixture(chainId = 1) {
  vi.resetModules()
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { recover } = await import('../src/recovery')
  const { NETWORK: network } = await import('../src/config')
  const selectedConfig = { ...config, chainId }
  const wallet = new Wallet(Wallet.createRandom().privateKey)
  const raw = await wallet.signTransaction({ to: network.proxyContract, data: '0x12345678', value: 0n,
    type: 2, chainId, nonce: 0, gasLimit: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })
  const hash = Transaction.from(raw).hash!
  store.signed('one', 'encrypted request', raw, hash, 200_000_000_000_000n, config.dailyBudget, 0, '{}', Date.now() + 60_000)
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: BigInt(chainId) })),
    getBlock: vi.fn(async (tag: string) => ({ number: tag === 'finalized' ? 80 : 100,
      hash: `0x${'12'.repeat(32)}`, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: chainId === 56 ? null : 1n })),
    getFeeData: vi.fn(async () => ({ gasPrice: 2_000_000_000n, maxPriorityFeePerGas: 1n })),
    estimateGas: vi.fn(async () => 21_221n),
    getBalance: vi.fn(async () => 10n ** 18n), getTransactionCount: vi.fn(async () => 0),
    getRpcTransaction: vi.fn((tx) => tx),
    send: vi.fn(async () => ({ type: 'CALL', to: network.proxyContract, input: '0x12345678' })),
  }
  const sender = { pendingTransaction: vi.fn((): { hash: string; nonce: number } | undefined => undefined),
    stageSigned: vi.fn(async () => hash), retryPending: vi.fn(async () => hash),
    cancelPending: vi.fn(async (signed: string) => Transaction.from(signed).hash!),
  }
  const sign = vi.spyOn(wallet, 'signTransaction')
  const run = (command: 'retry' | 'cancel', args: string[] = []) => recover(command, args, selectedConfig, store,
    provider as unknown as JsonRpcProvider, wallet, sender)
  return { wallet, raw, hash, provider, sender, sign, run, recover, network }
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
  await expect(f.recover('retry', [], { ...config, mode: 'mainnet', enabled: false }, store,
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
  const hash = await f.recover('cancel', ['3000000000', '2000000000'], unarmed, store,
    f.provider as unknown as JsonRpcProvider, f.wallet, f.sender)
  expect(store.get('one')?.cancel_hash).toBe(hash)
  expect(await f.recover('retry', [], unarmed, store,
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
  expect(f.provider.estimateGas).not.toHaveBeenCalled()
})

it('enforces cancellation caps before any new signature', async () => {
  const f = await fixture()
  await expect(f.run('cancel', ['20000000000', '2000000000'])).rejects.toThrow('limits')
  expect(f.sign).not.toHaveBeenCalled()
  expect(store.get('one')?.cancel_raw).toBeNull()
})

it.each([42161, 56, 137])('estimates and bounds chain %i cancellation gas, uses finalized state and retries identical bytes', async (chainId) => {
  const f = await fixture(chainId)
  const hash = await f.run('cancel', ['3000000000', '2000000000'])
  const raw = store.get('one')!.cancel_raw!
  const tx = Transaction.from(raw)
  expect(tx.chainId).toBe(BigInt(chainId))
  expect(tx.to).toBe(f.wallet.address)
  expect(tx.value).toBe(0n)
  expect(tx.data).toBe('0x')
  expect(tx.gasLimit).toBe(23_344n)
  expect(f.provider.estimateGas).toHaveBeenCalledWith(expect.objectContaining({
    from: f.wallet.address, to: f.wallet.address, chainId: BigInt(chainId), nonce: 0,
    maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
  }))
  expect(f.provider.getTransactionCount.mock.calls).toEqual([[f.wallet.address, 100], [f.wallet.address, 80]])
  expect(f.provider.getBlock.mock.calls).toEqual([['latest'], ['finalized']])
  expect(await f.run('retry')).toBe(hash)
  expect(f.sender.cancelPending.mock.calls).toEqual([[raw], [raw]])
  expect(f.sign).toHaveBeenCalledOnce()
  expect(store.get('one')!.raw).toBe(f.raw)
})

it.each([0n, 20_999n, 8_000_000n])('rejects invalid or excessive padded Arbitrum cancellation estimate %s before signing', async (estimate) => {
  const f = await fixture(42161)
  f.provider.estimateGas.mockResolvedValue(estimate)
  await expect(f.run('cancel', ['3000000000', '2000000000'])).rejects.toThrow()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
  expect(store.get('one')!.cancel_raw).toBeNull()
})

it('preserves recovery journals when non-Ethereum cancellation gas estimation fails', async () => {
  const f = await fixture(137)
  f.provider.estimateGas.mockRejectedValue(new Error('read node unavailable'))
  await expect(f.run('cancel', ['3000000000', '2000000000'])).rejects.toThrow('read node unavailable')
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
  expect(store.get('one')!.raw).toBe(f.raw)
  expect(store.get('one')!.cancel_raw).toBeNull()
})

it('enforces the current BNB gas-price floor for cancellation and retry even without a base fee', async () => {
  const f = await fixture(56)
  f.provider.getFeeData.mockResolvedValue({ gasPrice: 4_000_000_000n, maxPriorityFeePerGas: 1n })
  await expect(f.run('cancel', ['3000000000', '2000000000'])).rejects.toThrow('limits')
  await expect(f.run('retry')).rejects.toThrow('limits')
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.provider.send).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
})

it.each([56, 137])('rejects chain %i recovery when only the nominal EIP-1559 cap covers the network floor', async (chainId) => {
  const f = await fixture(chainId)
  f.provider.getFeeData.mockResolvedValue({ gasPrice: 2_500_000_000n, maxPriorityFeePerGas: 2_500_000_000n })
  await expect(f.run('cancel', ['3000000000', '2000000000'])).rejects.toThrow('limits')
  f.provider.getFeeData.mockResolvedValue({ gasPrice: 1_500_000_000n, maxPriorityFeePerGas: 1_500_000_000n })
  await expect(f.run('retry')).rejects.toThrow('limits')
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.provider.send).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
})

it('uses a legacy recovery transaction’s actual gas price instead of an implied one-wei priority fee', async () => {
  const f = await fixture(56)
  const raw = await f.wallet.signTransaction({ to: f.network.proxyContract, data: '0x12345678', value: 0n,
    type: 0, chainId: 56, nonce: 0, gasLimit: 100_000n, gasPrice: 2_000_000_000n })
  store.db.prepare('UPDATE requests SET raw=?,hash=? WHERE key=?').run(raw, Transaction.from(raw).hash!, 'one')
  f.sign.mockClear()
  await f.run('retry')
  expect(f.provider.send).toHaveBeenCalledOnce()
  expect(f.sender.stageSigned).toHaveBeenCalledWith(raw)
  expect(f.sender.retryPending).toHaveBeenCalledOnce()
  expect(f.sign).not.toHaveBeenCalled()
})

it('rejects a recovery read node on another chain before tracing, estimating or signing', async () => {
  const f = await fixture()
  f.provider.getNetwork.mockResolvedValue({ chainId: 56n })
  await expect(f.run('cancel', ['3000000000', '2000000000'])).rejects.toThrow('another chain')
  expect(f.provider.getBlock).not.toHaveBeenCalled()
  expect(f.provider.estimateGas).not.toHaveBeenCalled()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
})

it('rejects process/config chain mismatch before any read or disclosure', async () => {
  const f = await fixture()
  await expect(f.recover('cancel', ['3000000000', '2000000000'], { ...config, chainId: 56 }, store,
    f.provider as unknown as JsonRpcProvider, f.wallet, f.sender)).rejects.toThrow('process broadcaster chain')
  expect(f.provider.getNetwork).not.toHaveBeenCalled()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.stageSigned).not.toHaveBeenCalled()
})

it('rejects a saved cancellation from another chain without altering either recovery record', async () => {
  const f = await fixture(42161)
  const raw = await f.wallet.signTransaction({ type: 2, chainId: 56, nonce: 0, to: f.wallet.address,
    gasLimit: 24_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n })
  store.cancel('one', raw, Transaction.from(raw).hash!, 72_000_000_000_000n, config.dailyBudget)
  f.sign.mockClear()
  await expect(f.run('retry')).rejects.toThrow('cancellation record is inconsistent')
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.provider.send).not.toHaveBeenCalled()
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
  expect(store.get('one')!.raw).toBe(f.raw)
  expect(store.get('one')!.cancel_raw).toBe(raw)
})
