import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { getAddress, Interface, JsonRpcProvider, Transaction, Wallet, ZeroAddress, type TransactionReceipt } from 'ethers'
import { Broadcaster } from '../src/broadcaster'
import { Store } from '../src/storage'
import { issueFee } from '../src/fees'
import { ADAPT, PROXY } from '../src/transaction'
import { CHAIN, COMMON_TRANSACTION_TYPE, NETWORK, TOKENS } from '../src/config'
import { config, privateRequest, withdrawalRequest } from './request.fixture'
import { decodeGuardedExecution, executionGuardCode } from '../../railgun/operator/execution-guard'

const registry = new Interface(['function getContractAddress(string name) view returns (address)'])
const blockHash = `0x${'55'.repeat(32)}`
let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ophis-broadcaster-gates-')); store = new Store(directory) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

async function packetFor(data: Record<string, unknown>, publicViewingKey: string) {
  const encrypted = await encryptDataWithSharedKey(data, Buffer.from(publicViewingKey, 'hex'))
  const packet = { method: 'transact', id: 1, params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } }
  const payload = Buffer.from(JSON.stringify(packet))
  const decode = (response: Uint8Array | undefined) => {
    expect(response).toBeDefined()
    return tryDecryptJSONDataWithSharedKey(JSON.parse(Buffer.from(response!).toString()).result, encrypted.sharedKey) as { txHash?: string; error?: string }
  }
  return { packet, payload, decode }
}

async function fixture(guard?: string, withdrawalRecipient?: string) {
  const privateViewingKey = randomBytes(32), publicViewingKey = Buffer.from(await ed.getPublicKey(privateViewingKey)).toString('hex')
  const wallet = new Wallet(Wallet.createRandom().privateKey)
  const rates = { [TOKENS[0].address]: 10n ** 18n, [TOKENS[1].address]: 2_000_000_000n, [TOKENS[2].address]: 2_000_000_000n }
  const quote = issueFee(store, rates)
  const data = withdrawalRecipient ? await withdrawalRequest(quote.id, publicViewingKey, withdrawalRecipient)
    : await privateRequest(quote.id, publicViewingKey)
  const wire = await packetFor(data, publicViewingKey)
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: CHAIN })),
    getFeeData: vi.fn(async () => ({ gasPrice: 2n })),
    getBlock: vi.fn(async () => ({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n })),
    getTransactionCount: vi.fn(async () => 0), getBalance: vi.fn(async () => 10n ** 18n),
    getBlockNumber: vi.fn(async () => 100),
    getTransactionReceipt: vi.fn(async (_hash?: string): Promise<Pick<TransactionReceipt, 'status' | 'blockNumber' | 'blockHash' | 'gasUsed' | 'gasPrice'> | null> => null),
    estimateGas: vi.fn(async () => 100_000n),
    getCode: vi.fn(async (address: string) => address === guard
      ? executionGuardCode(wallet.address, '0x6001', NETWORK.relayAdapt7702Contract) : '0x6001'),
    call: vi.fn(async (tx: { data: string }) => {
      if (tx.data.startsWith(registry.getFunction('getContractAddress')!.selector))
        return registry.encodeFunctionResult('getContractAddress', [NETWORK.relayAdapt7702Contract])
      if (tx.data === ADAPT.encodeFunctionData('adaptImplementation'))
        return ADAPT.encodeFunctionResult('adaptImplementation', [NETWORK.relayAdapt7702Contract])
      return ADAPT.encodeFunctionResult('nonce', [0n])
    }),
    getRpcTransaction: vi.fn((value) => value), send: vi.fn(async (): Promise<unknown> => ({ type: 'CALL', calls: [
      { type: 'CALL', to: NETWORK.proxyContract, input: withdrawalRecipient ? String(data.data) : PROXY.encodeFunctionData('transact', [
        ADAPT.decodeFunctionData('execute', String(data.data))._transactions,
      ]) },
    ] })),
  }
  const sdk = { address: 'test-fee-identity', privateViewingKey, publicViewingKey, ready: () => true,
    sign: vi.fn(async () => 'signature'),
    fee: vi.fn(async () => withdrawalRecipient ? { [TOKENS[1].address]: 2_000_000n } : { [TOKENS[0].address]: 2_000_000_000_000_000n }),
    validate: vi.fn(async () => ({ railgunTxid: 'test-txid', utxoTreeIn: 0, commitment: 'test-commitment', notePublicKey: 'test-npk', pois: {} })),
    assure: vi.fn(async () => true),
  }
  const sender = { broadcastTransaction: vi.fn(async (raw: string) => ({ hash: Transaction.from(raw).hash! })) }
  const sign = vi.spyOn(wallet, 'signTransaction')
  const service = new Broadcaster({ ...config, executionGuard: guard, pilotWithdrawalRecipient: withdrawalRecipient }, store, sdk, provider as unknown as JsonRpcProvider, wallet, sender,
    { rates: async () => rates })
  return { ...wire, data, quote, service, sdk, provider, sender, sign, rates }
}

async function confirm(f: Awaited<ReturnType<typeof fixture>>, hash: string, status = 1) {
  const record = store.pending().find((r) => r.hash === hash)!
  f.provider.getTransactionCount.mockImplementation(async (address?: string) => address === f.service.wallet.address ? record.nonce + 1 : 0)
  f.provider.getTransactionReceipt.mockImplementation(async (requested?: string) => requested === hash
    ? { status, blockNumber: 99, blockHash, gasUsed: 100_000n, gasPrice: 2_000_000_000n } : null)
  await f.service.reconcile()
}

describe('signing gate and duplicate recovery', () => {
  it.each([false, true])('repeats the trace after a same-height reorg and rejects an expired final head: %s', async (expires) => {
    const f = await fixture(Wallet.createRandom().address)
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let heads = 0, traces = 0
    f.provider.getBlock.mockImplementation(async (tag?: string | number) => {
      if (tag === 'latest') heads++
      return { number: 100, hash: heads < 2 ? blockHash : `0x${'66'.repeat(32)}`,
        timestamp: Math.floor(now / 1000), baseFeePerGas: 1n }
    })
    const originalTrace = await f.provider.send()
    f.provider.send.mockImplementation(async () => {
      traces++
      if (expires && traces === 2) clock.mockReturnValue(now + 46_000)
      return originalTrace
    })
    try {
      const result = f.decode(await f.service.handle(f.payload))
      expect(traces).toBe(2)
      expect(f.sign).toHaveBeenCalledTimes(expires ? 0 : 1)
      if (expires) expect(result.error).toContain('signing')
      else expect(result.txHash).toBeTruthy()
    } finally { clock.mockRestore() }
  })
  it('permits one atomic USDC withdrawal to the pinned recipient, persists the one-time gate, and replays duplicates', async () => {
    const recipient = Wallet.createRandom().address
    const f = await fixture(Wallet.createRandom().address, recipient)
    f.service.config.pilotAccount = Wallet.createRandom().address
    const result = f.decode(await f.service.handle(f.payload))
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    const signed = Transaction.from(store.get((store.db.prepare('SELECT key FROM requests').get() as { key: string }).key)!.raw!)
    expect(signed.to).toBe(getAddress(NETWORK.proxyContract))
    expect(signed.type).toBe(COMMON_TRANSACTION_TYPE)
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe(result.txHash)
    expect(await f.service.available()).toBe(false)
    expect(f.decode(await f.service.handle(f.payload))).toEqual(result)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sdk.validate).toHaveBeenCalledOnce()
  })
  it.each(['unconfigured', 'recipient', 'fee-token', 'underpaid', 'used'])('rejects an unsafe withdrawal pilot: %s', async (kind) => {
    const f = await fixture(undefined, Wallet.createRandom().address)
    if (kind === 'unconfigured') f.service.config.pilotWithdrawalRecipient = undefined
    if (kind === 'recipient') f.service.config.pilotWithdrawalRecipient = Wallet.createRandom().address
    if (kind === 'fee-token') f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 2_000_000_000_000_000n })
    if (kind === 'underpaid') f.sdk.fee.mockResolvedValue({ [TOKENS[1].address]: 1n })
    if (kind === 'used') store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', 'previous-hash')
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('prices a common withdrawal above the current base fee without changing its proof or fee', async () => {
    const f = await fixture(undefined, Wallet.createRandom().address)
    const minimum = BigInt(f.data.minGasPrice as string)
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: minimum })
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const row = store.pending()[0]
    const signed = Transaction.from(row.raw!)
    expect(signed.gasPrice).toBe(minimum + 1n)
    expect(signed.data).toBe(f.data.data)
    expect(BigInt(row.max_cost)).toBe(signed.gasLimit * (minimum + 1n))
    expect(f.sdk.fee).toHaveBeenCalledOnce()
  })
  it.each(['cap', 'payment'])('never signs a repriced withdrawal exceeding its %s', async (reason) => {
    const f = await fixture(undefined, Wallet.createRandom().address)
    const base = reason === 'cap' ? config.maxGasPrice : BigInt(f.data.minGasPrice as string)
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: base })
    if (reason === 'payment') f.sdk.fee.mockResolvedValue({ [TOKENS[1].address]: 440_000n })
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('advertises remaining budget while retaining the exact per-request and journal spending gates', async () => {
    const f = await fixture()
    f.service.config.dailyBudget = f.service.config.maxTransactionCost
    store.signed('old', 'envelope', 'raw', 'oldhash', 1n, config.dailyBudget, 0)
    store.confirmed('old', 1n, Date.now())
    store.assured('old')
    expect(await f.service.available()).toBe(true)
    f.service.config.dailyBudget = 2n
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('halts new signing until a confirmed earlier request has its fee assured', async () => {
    const f = await fixture()
    store.signed('old', 'envelope', 'raw', 'oldhash', 1n, config.dailyBudget, 0)
    store.confirmed('old', 1n, Date.now())
    f.provider.getTransactionCount.mockImplementation(async (address?: string) => address === f.data.to ? 0 : 1)
    expect(await f.service.available()).toBe(false)
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    store.assured('old')
    expect(await f.service.available()).toBe(true)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('advertises fees with lowercase token keys for the RAILGUN client cache while preserving stored rates', async () => {
    const f = await fixture()
    const envelope = JSON.parse(Buffer.from(await f.service.feeAdvertisement()).toString())
    const advertisement = JSON.parse(Buffer.from(envelope.data, 'hex').toString())
    expect(advertisement.fees[TOKENS[0].address.toLowerCase()]).toBe('0xde0b6b3a7640000')
    expect(Object.keys(advertisement.fees).every((token) => token === token.toLowerCase())).toBe(true)
    const stored = store.db.prepare('SELECT rates FROM fees WHERE id=?').get(advertisement.feesID) as { rates: string }
    expect(JSON.parse(stored.rates)[getAddress(TOKENS[0].address)]).toBe('0xde0b6b3a7640000')
    expect(f.sdk.sign).toHaveBeenCalledWith(envelope.data)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('rejects other accounts before proof work and signing during the restricted pilot', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.pilotAccount = Wallet.createRandom().address
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    f.service.config.pilotAccount = String(f.data.to)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
  })
  it('wraps the exact fee-validated request without changing the user authorization or execution', async () => {
    const guard = Wallet.createRandom().address
    const f = await fixture(guard)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const signed = Transaction.from(store.pending()[0].raw!)
    expect(signed.to).toBe(guard)
    expect(decodeGuardedExecution(signed.data)).toEqual({ account: f.data.to, execution: f.data.data, nonce: 0n })
    expect(f.sdk.validate).toHaveBeenCalledOnce()
    expect(f.provider.getCode).toHaveBeenCalledWith(guard, 100)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it('refuses an unreviewed execution guard before signing', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.provider.getCode.mockResolvedValue('0x00')
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('does not advertise availability when the current base fee exceeds the operator cap', async () => {
    const f = await fixture()
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: config.maxGasPrice })
    expect(await f.service.available()).toBe(false)
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('journals the request and raw transaction before private disclosure, then replays the response without signing again', async () => {
    const f = await fixture()
    let journaledBeforeSend = false
    f.sender.broadcastTransaction.mockImplementationOnce(async (raw) => {
      const row = store.pending()[0]
      journaledBeforeSend = row?.raw === raw && row.fee_data.includes('test-commitment')
      return { hash: Transaction.from(raw).hash! }
    })
    const response = f.decode(await f.service.handle(f.payload))
    expect(response.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(journaledBeforeSend).toBe(true)
    expect(f.sdk.validate).toHaveBeenCalledOnce()
    expect(f.sign).toHaveBeenCalledOnce()
    const duplicate = Buffer.from(JSON.stringify({ ...f.packet, id: 99 }))
    expect(f.decode(await f.service.handle(duplicate))).toEqual(response)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it.each(['fee', 'proof', 'trace', 'nonce', 'budget'])('never signs when %s validation fails', async (kind) => {
    const f = await fixture()
    if (kind === 'fee') f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 1n })
    if (kind === 'proof') f.sdk.validate.mockRejectedValue(new Error('secret private proof details'))
    if (kind === 'trace') f.provider.send.mockResolvedValue({ type: 'CALL', calls: [{ type: 'CALL', error: 'revert' }] } as { type: string })
    if (kind === 'nonce') f.provider.getTransactionCount.mockResolvedValue(1)
    if (kind === 'budget') store.signed('old', 'envelope', 'old-signed', 'hash', config.dailyBudget, config.dailyBudget, 0)
    const result = f.decode(await f.service.handle(f.payload))
    expect(result.error).toBeTruthy()
    expect(result.error).not.toContain('secret private')
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('keeps an unknown submission locked and does not sign a replacement after restart', async () => {
    const f = await fixture()
    f.sender.broadcastTransaction.mockRejectedValueOnce(new Error('upstream error containing sensitive data'))
    const first = f.decode(await f.service.handle(f.payload))
    expect(first.error).toContain('outcome is unknown')
    expect(store.pending()[0].raw).toBeTruthy()
    expect(store.exposure()).toBeGreaterThan(0n)
    expect(f.decode(await f.service.handle(f.payload))).toEqual(first)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(await f.service.available()).toBe(false)
  })
  it('ignores an identical in-flight retry instead of sending an error that could beat the result', async () => {
    const f = await fixture()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    f.sdk.validate.mockImplementationOnce(async () => {
      await waiting
      return { railgunTxid: 'txid', utxoTreeIn: 0, commitment: 'commitment', notePublicKey: 'npk', pois: {} }
    })
    const first = f.service.handle(f.payload)
    await vi.waitFor(() => expect(f.sdk.validate).toHaveBeenCalledOnce())
    expect(await f.service.handle(f.payload)).toBeUndefined()
    release()
    expect(f.decode(await first).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('rechecks the user authorization nonce after slow proof validation', async () => {
    const f = await fixture()
    let proofComplete = false
    f.sdk.validate.mockImplementationOnce(async () => {
      proofComplete = true
      return { railgunTxid: 'txid', utxoTreeIn: 0, commitment: 'commitment', notePublicKey: 'npk', pois: {} }
    })
    f.provider.getTransactionCount.mockImplementation(async (address?: string) =>
      proofComplete && address === f.data.to ? 1 : 0)
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('rejects unpaid junk before EVM work without consuming the validated trade allowance', async () => {
    const f = await fixture()
    f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 0n })
    for (let i = 0; i < 30; i++) expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.provider.estimateGas).not.toHaveBeenCalled()
    f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 2_000_000_000_000_000n })
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
})

describe('public admission and sequential settlement', () => {
  it('resolves an explicit confirmed cancellation without claiming a private fee was delivered', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const record = store.pending()[0], cancelHash = `0x${'ab'.repeat(32)}`
    store.cancel(record.key, 'saved-cancellation', cancelHash, 1n, config.dailyBudget)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getTransactionReceipt.mockImplementation(async (hash?: string) => hash === cancelHash
      ? { status: 1, blockNumber: 99, blockHash, gasUsed: 21_000n, gasPrice: 2_000_000_000n } : null)
    await f.service.reconcile()
    expect(store.hasPending()).toBe(false)
    expect(await f.service.available()).toBe(true)
    expect(f.sdk.assure).not.toHaveBeenCalled()
    expect(store.get(record.key)?.actual_cost).toBe((21_000n * 2_000_000_000n).toString())
    expect(store.get(record.key)?.cancel_hash).toBe(cancelHash)
  })
  it.each(TOKENS)('permits repeated $symbol withdrawals with the fee in that token and preserves a used pilot marker', async (token) => {
    const f = await fixture(Wallet.createRandom().address, Wallet.createRandom().address)
    f.service.config.admission = 'public'
    f.service.config.pilotWithdrawalRecipient = undefined
    store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', 'historical-pilot-hash')
    for (let nonce = 0; nonce < 2; nonce++) {
      const data = await withdrawalRequest(f.quote.id, f.sdk.publicViewingKey, Wallet.createRandom().address, 1, 1, token.address,
        `0x${(nonce + 1).toString(16).padStart(64, '0')}`)
      const wire = await packetFor(data, f.sdk.publicViewingKey)
      f.sdk.fee.mockResolvedValue({ [getAddress(token.address)]: token.address === TOKENS[0].address ? 2_000_000_000_000_000n : 2_000_000n })
      f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract, input: data.data })
      const response = wire.decode(await f.service.handle(wire.payload))
      expect(response.txHash).toBeTruthy()
      const signed = Transaction.from(store.pending()[0].raw!)
      expect(signed.nonce).toBe(nonce)
      expect(signed.to).toBe(getAddress(NETWORK.proxyContract))
      expect(await f.service.available()).toBe(false)
      await confirm(f, response.txHash!)
      expect(store.hasPending()).toBe(false)
      expect(await f.service.available()).toBe(true)
      expect(wire.decode(await f.service.handle(wire.payload))).toEqual(response)
    }
    expect(f.sign).toHaveBeenCalledTimes(2)
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historical-pilot-hash')
    f.service.config.admission = 'pilot'
    f.service.config.pilotWithdrawalRecipient = Wallet.createRandom().address
    expect(await f.service.available()).toBe(false)
  })

  it('serves unrelated swap accounts sequentially without replacing the operator or signing duplicates', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    const accounts = new Set<string>()
    for (let nonce = 0; nonce < 2; nonce++) {
      const data = await privateRequest(f.quote.id, f.sdk.publicViewingKey, `0x${(nonce + 1).toString(16).padStart(64, '0')}`)
      accounts.add(String(data.to))
      const wire = await packetFor(data, f.sdk.publicViewingKey)
      f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract,
        input: PROXY.encodeFunctionData('transact', [ADAPT.decodeFunctionData('execute', String(data.data))._transactions]) })
      const response = wire.decode(await f.service.handle(wire.payload))
      expect(response.txHash).toBeTruthy()
      const tx = Transaction.from(store.pending()[0].raw!)
      expect(tx.from).toBe(f.service.wallet.address)
      expect(tx.nonce).toBe(nonce)
      expect(decodeGuardedExecution(tx.data).account).toBe(data.to)
      await confirm(f, response.txHash!)
      expect(wire.decode(await f.service.handle(Buffer.from(JSON.stringify({ ...wire.packet, id: 99 }))))).toEqual(response)
    }
    expect(accounts.size).toBe(2)
    expect(f.sign).toHaveBeenCalledTimes(2)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(2)
  })

  it.each(['zero-recipient', 'high-recipient', 'token', 'zero-amount', 'nft', 'sub-id', 'fee-token', 'underpaid', 'expired'])('rejects an unsafe public withdrawal before signing: %s', async (kind) => {
    const f = await fixture(undefined, Wallet.createRandom().address)
    f.service.config.admission = 'public'
    f.service.config.pilotWithdrawalRecipient = undefined
    const recipient = kind === 'zero-recipient' ? ZeroAddress : kind === 'high-recipient'
      ? `0x01${Wallet.createRandom().address.slice(2)}` : Wallet.createRandom().address
    const data = await withdrawalRequest(f.quote.id, f.sdk.publicViewingKey, recipient, 1, 1,
      kind === 'token' ? Wallet.createRandom().address : TOKENS[1].address)
    if (['zero-amount', 'nft', 'sub-id'].includes(kind)) {
      const transaction = PROXY.decodeFunctionData('transact', String(data.data))._transactions[0].toObject()
      transaction.unshieldPreimage = transaction.unshieldPreimage.toObject()
      transaction.unshieldPreimage.token = transaction.unshieldPreimage.token.toObject()
      if (kind === 'zero-amount') transaction.unshieldPreimage.value = 0n
      if (kind === 'nft') transaction.unshieldPreimage.token.tokenType = 1n
      if (kind === 'sub-id') transaction.unshieldPreimage.token.tokenSubID = 1n
      data.data = PROXY.encodeFunctionData('transact', [[transaction]])
    }
    if (kind === 'fee-token') f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 2_000_000_000_000_000n })
    if (kind === 'underpaid') f.sdk.fee.mockResolvedValue({ [TOKENS[1].address]: 1n })
    if (kind === 'expired') store.db.prepare('UPDATE fees SET expiration=0 WHERE id=?').run(f.quote.id)
    f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract, input: data.data })
    const wire = await packetFor(data, f.sdk.publicViewingKey)
    const error = wire.decode(await f.service.handle(wire.payload)).error
    const expected = ['zero-recipient', 'high-recipient'].includes(kind) ? 'nonzero public address'
      : ['token', 'zero-amount', 'nft', 'sub-id'].includes(kind) ? 'supported fee token'
      : kind === 'fee-token' ? 'withdrawn token' : kind === 'expired' ? 'fee quote expired' : 'does not cover execution'
    expect(error).toContain(expected)
    expect(f.sdk.validate).not.toHaveBeenCalled()
    if (!['fee-token', 'underpaid'].includes(kind)) expect(f.sdk.fee).not.toHaveBeenCalled()
    if (kind !== 'underpaid') expect(f.provider.send).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(store.hasPending()).toBe(false)
  })

  it('rejects another user while validation is in progress without consuming a second signature', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const proof = await f.sdk.validate()
    f.sdk.validate.mockImplementationOnce(async () => { await waiting; return proof })
    f.sdk.validate.mockClear()
    const first = f.service.handle(f.payload)
    await vi.waitFor(() => expect(f.sdk.validate).toHaveBeenCalledOnce())
    const other = await packetFor(await privateRequest(f.quote.id, f.sdk.publicViewingKey, `0x${'13'.repeat(32)}`), f.sdk.publicViewingKey)
    expect(other.decode(await f.service.handle(other.payload)).error).toContain('finishing another transaction')
    expect(f.sign).not.toHaveBeenCalled()
    release()
    expect(f.decode(await first).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })

  it.each(['unknown-submission', 'missing-fee', 'included-revert', 'unknown-nonce'])('preserves the halt across restart for %s', async (reason) => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    if (reason === 'unknown-submission') f.sender.broadcastTransaction.mockRejectedValueOnce(new Error('unknown'))
    const first = f.decode(await f.service.handle(f.payload))
    const saved = store.pending()[0]
    store.close(); store = new Store(directory)
    f.service = new Broadcaster(f.service.config, store, f.sdk, f.service.provider, f.service.wallet, f.sender, { rates: async () => f.rates })
    expect(f.decode(await f.service.handle(f.payload))).toEqual(first)
    expect(await f.service.available()).toBe(false)
    expect(store.hasPending()).toBe(true)
    f.sdk.assure.mockResolvedValue(false)
    if (reason === 'missing-fee' || reason === 'included-revert') await confirm(f, saved.hash!, reason === 'included-revert' ? 0 : 1)
    if (reason === 'unknown-nonce') {
      f.provider.getTransactionCount.mockResolvedValue(1)
      await f.service.reconcile()
    }
    expect(await f.service.available()).toBe(false)
    expect(store.get(saved.key)?.raw).toBe(saved.raw)
    expect(store.get(saved.key)?.assured).toBe(0)
    const other = await packetFor(await privateRequest(f.quote.id, f.sdk.publicViewingKey, `0x${'13'.repeat(32)}`), f.sdk.publicViewingKey)
    expect(other.decode(await f.service.handle(other.payload)).error).toContain('finishing another transaction')
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
    if (reason === 'missing-fee') {
      f.sdk.assure.mockResolvedValue(true)
      await f.service.reconcile()
      expect(await f.service.available()).toBe(true)
    }
    if (reason === 'included-revert') {
      f.sdk.assure.mockResolvedValue(true)
      await f.service.reconcile()
      expect(await f.service.available()).toBe(false)
    }
  })
})
