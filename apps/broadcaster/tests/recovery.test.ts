import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { id, JsonRpcProvider, Transaction, Wallet, type TransactionReceipt } from 'ethers'
import { Store } from '../src/storage'
import { config } from './request.fixture'
import { cliBacking } from './main-sdk.fixture'
import { CreditLedger, creditCharge } from '../src/credit'

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
  const sender = { pendingTransaction: vi.fn((): { hash: string; nonce: number; cancellationHash?: string } | undefined => undefined),
    stageSigned: vi.fn(async (_raw: string) => hash), retryPending: vi.fn(async () => hash),
    stageRecovery: vi.fn(async (raw: string, _pending: { hash: string; nonce: number; cancellationHash?: string }) => Transaction.from(raw).hash!),
    cancelPending: vi.fn(async (signed: string) => Transaction.from(signed).hash!),
  }
  const sign = vi.spyOn(wallet, 'signTransaction')
  const run = (command: 'retry' | 'cancel', args: string[] = []) => recover(command, args, selectedConfig, store,
    provider as unknown as JsonRpcProvider, wallet, sender)
  return { wallet, raw, hash, provider, sender, sign, run, recover, network, selectedConfig }
}

async function reorgedPrepaid(f: Awaited<ReturnType<typeof fixture>>, chainId: number) {
  store.db.exec('DELETE FROM requests')
  if (chainId === 56) f.provider.getFeeData.mockResolvedValue({ gasPrice: 1_000_000_000n, maxPriorityFeePerGas: 1n })
  const ledger = new CreditLedger(store, { chainId, operator: f.wallet.address, token: f.network.baseToken.wrappedAddress,
    recipient: '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f' })
  const owner = Wallet.createRandom().address, rate = 115n * 10n ** 16n, gasBudget = 200_000_000_000_000n
  ledger.deposit({ owner, amount: 10n ** 18n, tree: 0, position: 0, commitment: id('reorg-deposit'),
    transactionHash: id('reorg-topup'), blockHash: id('funded-block'), blockNumber: 1 })
  const operations = []
  for (const nonce of [0, 1]) {
    const raw = await f.wallet.signTransaction({ ...Transaction.from(f.raw).toJSON(), nonce, signature: undefined })
    const key = id(`reorg-${nonce}`), tx = Transaction.from(raw)
    ledger.reserve({ key, owner, sequence: ledger.nextSequence(owner), unsigned: tx.unsignedSerialized, envelope: 'synthetic encrypted request', nonce,
      gasBudget, rate, maximumCharge: creditCharge(gasBudget, rate, 0n), collectionAllowance: 0n,
      expiration: Date.now() + 60_000, dailyBudget: config.dailyBudget, backing: await cliBacking(ledger.accountedNotes()) })
    ledger.attachSignature(key, raw)
    const receipt = { hash: tx.hash!, status: 1, blockHash: id(`orphan-${nonce}`), blockNumber: 90 + nonce,
      gasUsed: 50_000n, gasPrice: 1_000_000_000n } as TransactionReceipt
    ledger.observeInclusion(key, receipt)
    operations.push({ key, raw, hash: tx.hash!, nonce, receipt })
  }
  // The service's canonical reconciliation calls this for each disappeared prefinal inclusion.
  for (const item of operations) ledger.forgetInclusion(item.key)
  let pointer = { hash: operations[1].hash, nonce: 1 }
  f.sender.pendingTransaction.mockImplementation(() => pointer)
  const stage = async (raw: string) => { const tx = Transaction.from(raw); pointer = { hash: tx.hash!, nonce: tx.nonce }; return tx.hash! }
  f.sender.stageSigned.mockImplementation(stage)
  f.sender.stageRecovery.mockImplementation(stage)
  f.sender.retryPending.mockImplementation(async () => pointer.hash)
  f.sign.mockClear()
  return { ledger, owner, operations, maximum: 2n * creditCharge(gasBudget, rate, 0n) }
}

it.each([1, 56])('recovers multiple reorged chain %i nonces in order without re-signing or releasing credit holds', async (chainId) => {
  const f = await fixture(chainId), state = await reorgedPrepaid(f, chainId)
  expect(await f.run('retry')).toBe(state.operations[0].hash)
  expect(f.sender.stageRecovery).toHaveBeenCalledWith(state.operations[0].raw, { hash: state.operations[1].hash, nonce: 1 })
  expect(state.ledger.balance(state.owner).reserved).toBe(state.maximum)
  state.ledger.observeInclusion(state.operations[0].key, state.operations[0].receipt)
  f.provider.getTransactionCount.mockResolvedValue(1)
  expect(await f.run('retry')).toBe(state.operations[1].hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(state.operations[1].raw)
  expect(f.sign).not.toHaveBeenCalled()
  expect(state.ledger.balance(state.owner).reserved).toBe(state.maximum)
  for (const item of state.operations) expect(store.get(item.key)?.raw).toBe(item.raw)
})

it.each(['missing-hold', 'transport-mismatch', 'unknown-cancellation', 'restored-backup'])('retains every reorg hold when %s prevents recovery', async (reason) => {
  const f = await fixture(), state = await reorgedPrepaid(f, 1)
  if (reason === 'missing-hold') store.db.prepare('DELETE FROM credit_attempts WHERE key=?').run(state.operations[1].key)
  if (reason === 'transport-mismatch') f.sender.pendingTransaction.mockReturnValue({ hash: id('unknown'), nonce: 1 })
  if (reason === 'unknown-cancellation') f.sender.pendingTransaction.mockReturnValue({ hash: state.operations[1].hash, nonce: 1, cancellationHash: id('unknown-cancel') })
  if (reason === 'restored-backup') store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('creditRecoveryRequired', '1')
  await expect(f.run('cancel', ['3000000000', '2000000000'])).rejects.toThrow()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.stageRecovery).not.toHaveBeenCalled()
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
  expect(f.sender.retryPending).not.toHaveBeenCalled()
  for (const item of state.operations) {
    expect(store.get(item.key)?.raw).toBe(item.raw)
    expect(store.get(item.key)?.confirmed).toBe(0)
  }
})

it.each([1, 56])('recovers a chain %i reservation before signature without publishing a second operation', async (chainId) => {
  const f = await fixture(chainId)
  store.db.exec('DELETE FROM requests')
  const scope = { chainId, operator: f.wallet.address, token: f.network.baseToken.wrappedAddress,
    recipient: '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f' }
  const ledger = new CreditLedger(store, scope), owner = Wallet.createRandom().address, key = id('prepaid reservation')
  ledger.deposit({ owner, amount: 10n ** 18n, commitment: id('deposit'), transactionHash: id('topup'), blockHash: id('block'), blockNumber: 1, tree: 0, position: 0 })
  const gasBudget = 200_000_000_000_000n, rate = 115n * 10n ** 16n
  ledger.reserve({ key, owner, sequence: ledger.nextSequence(owner), unsigned: Transaction.from(f.raw).unsignedSerialized, envelope: 'encrypted', nonce: 0,
    gasBudget, rate, maximumCharge: creditCharge(gasBudget, rate, 0n), collectionAllowance: 0n,
    expiration: Date.now() + 60_000, dailyBudget: config.dailyBudget, backing: await cliBacking(ledger.accountedNotes()) })
  await expect(f.run('cancel', ['9999999999', '2000000000'])).rejects.toThrow('secured prepaid budget')
  expect(f.sign).not.toHaveBeenCalled()
  expect(store.get(key)?.raw).toBeNull()
  const hash = await f.run('cancel', ['3000000000', '2000000000'])
  expect(store.get(key)?.hash).toBe(f.hash)
  expect(store.get(key)?.cancel_hash).toBe(hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(f.raw)
  expect(f.sender.cancelPending).toHaveBeenCalledOnce()
  expect(f.sender.retryPending).not.toHaveBeenCalled()
  expect(f.sign).toHaveBeenCalledTimes(2)
  expect(ledger.balance(owner).reserved).toBe(creditCharge(gasBudget, rate, 0n))
})

it('stages a crash-gap transaction and retries identical signed bytes without signing again', async () => {
  const f = await fixture()
  expect(await f.run('retry')).toBe(f.hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(f.raw)
  expect(f.sender.retryPending).toHaveBeenCalledOnce()
  expect(f.sign).not.toHaveBeenCalled()
})

it.each([1, 56])('blocks an original chain %i mainnet pilot retry before any execution or disclosure', async (chainId) => {
  const f = await fixture(chainId)
  await expect(f.recover('retry', [], { ...f.selectedConfig, mode: 'mainnet', enabled: false }, store,
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

it.each([1, 56])('preserves explicit chain %i mainnet pilot cancellation and identical cancellation retry while unarmed', async (chainId) => {
  const f = await fixture(chainId)
  const unarmed = { ...f.selectedConfig, mode: 'mainnet' as const, enabled: false }
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
