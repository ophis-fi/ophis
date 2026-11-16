import { afterEach, expect, it, vi } from 'vitest'
import { id, toBeHex, toQuantity, Transaction, Wallet, ZeroAddress, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { nativeBackingEvidence, nativeHistoryCatalog, verifyNativeBacking, type NativePendingAttempt } from '../src/credit-native-payment'

const chain = vi.hoisted(() => ({ id: 42161 }))
vi.mock('../src/config', async importOriginal => ({ ...await importOriginal<typeof import('../src/config')>(),
  get CHAIN() { return BigInt(chain.id) }, get CHAIN_ID() { return chain.id },
}))
afterEach(() => { chain.id = 42161; vi.restoreAllMocks() })

function fixture() {
  const operator = Wallet.createRandom(), recipient = Wallet.createRandom(), ledgerId = id('inflight ledger')
  const scope = { chainId: chain.id, operator: operator.address, recipient: operator.address, token: ZeroAddress, funding: 'native' as const }
  const state = { finalized: 10, head: 20, finalizedNonce: 0, nonce: 0, balance: 50_000_000n, code: '0x', finalizedCode: '0x' }
  const changed = new Map<number, string>(), receipts = new Map<string, TransactionReceipt>()
  const block = (number: number) => ({ number, hash: changed.get(number) ?? id(`inflight block ${number}`), timestamp: Math.floor(Date.now() / 1000) })
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: BigInt(chain.id) })),
    getBlock: vi.fn(async (tag: number | string) => block(tag === 'latest' ? state.head : tag === 'finalized' ? state.finalized : Number(tag))),
    getBalance: vi.fn(async () => state.balance),
    getTransactionCount: vi.fn(async (_address: string, number: number) => number === state.finalized ? state.finalizedNonce : state.nonce),
    getCode: vi.fn(async (_address: string, number: number) => number === state.finalized ? state.finalizedCode : state.code),
    getTransactionReceipt: vi.fn(async (hash: string) => receipts.get(hash) ?? null),
  } as unknown as JsonRpcProvider
  async function attempt(nonce = 0, value = 0n, type = 2): Promise<NativePendingAttempt> {
    const raw = await operator.signTransaction({ type, chainId: chain.id, nonce, to: recipient.address, value,
      data: value ? '0x' : '0x1234', gasLimit: 100_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
      ...(type === 4 ? { authorizationList: [await recipient.authorize({ chainId: chain.id, nonce: 0, address: Wallet.createRandom().address })] } : {}),
    })
    return { nonce, raw, cancellations: [], maximumCost: 1_000_000n }
  }
  async function cancellation(item: NativePendingAttempt) {
    const raw = await operator.signTransaction({ type: 2, chainId: chain.id, nonce: item.nonce, to: operator.address,
      value: 0n, data: '0x', gasLimit: 21_000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n })
    item.cancellations = [...item.cancellations, raw]
    return raw
  }
  function include(raw: string, status = 1, number = 11) {
    const tx = Transaction.from(raw), b = block(number)
    const receipt = { hash: tx.hash!, from: tx.from!, to: tx.to, blockNumber: number, blockHash: b.hash,
      status, gasUsed: 21_000n, gasPrice: 3n } as TransactionReceipt
    receipts.set(tx.hash!, receipt)
    state.nonce = Math.max(state.nonce, tx.nonce + 1)
    return receipt
  }
  const backing = (pending: readonly NativePendingAttempt[] = []) => verifyNativeBacking(provider, scope, ledgerId, [], [], pending)
  return { operator, recipient, ledgerId, scope, state, changed, receipts, block, provider, attempt, cancellation, include, backing }
}

it('proves sequential included type-2/type-4 costs without changing actual available balance', async () => {
  const f = fixture(), a = await f.attempt(), b = await f.attempt(1, 0n, 4)
  f.include(a.raw); f.include(b.raw, 1, 12)
  const proof = nativeBackingEvidence(await f.backing([b, a]))
  expect(proof).toMatchObject({ available: f.state.balance, nonce: 2, pendingOutflow: 126_000n,
    catalog: nativeHistoryCatalog([], [], [a, b]) })
  expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(2)
})

it.each([0, 1])('counts successful payout principal only, status %i', async status => {
  const f = fixture(), a = await f.attempt(0, 500_000n)
  f.include(a.raw, status)
  expect(nativeBackingEvidence(await f.backing([a])).pendingOutflow).toBe(63_000n + (status ? 500_000n : 0n))
})

it('counts the included cancellation without the original refund principal', async () => {
  const f = fixture(), a = await f.attempt(0, 500_000n), raw = await f.cancellation(a)
  f.include(raw)
  expect(nativeBackingEvidence(await f.backing([a])).pendingOutflow).toBe(63_000n)
  expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(2)
})

it('retains finalized pending spend until local settlement and does not require older settled nonce descriptors', async () => {
  const f = fixture(), a = await f.attempt(3), b = await f.attempt(4)
  f.state.finalizedNonce = 4
  f.include(a.raw, 1, 9); f.include(b.raw)
  expect(nativeBackingEvidence(await f.backing([a, b]))).toMatchObject({ nonce: 5, pendingOutflow: 126_000n })
  expect(nativeBackingEvidence(await f.backing([b])).pendingOutflow).toBe(63_000n)
})

it.each(['unsigned', 'nonce', 'chain', 'signer', 'budget', 'duplicate-nonce', 'duplicate-candidate', 'cancel-target'])('rejects unauthenticated pending catalog: %s', async kind => {
  const f = fixture(), a = await f.attempt()
  if (kind === 'unsigned') a.raw = Transaction.from(a.raw).unsignedSerialized
  if (kind === 'nonce') a.nonce++
  if (kind === 'chain') a.raw = await f.operator.signTransaction({ ...Transaction.from(a.raw).toJSON(), chainId: 1 })
  if (kind === 'signer') a.raw = await f.recipient.signTransaction(Transaction.from(a.raw).toJSON())
  if (kind === 'budget') a.maximumCost--
  if (kind === 'duplicate-candidate') a.cancellations = [await f.cancellation(a), ...a.cancellations]
  if (kind === 'cancel-target') a.cancellations = [a.raw]
  await expect(f.backing(kind === 'duplicate-nonce' ? [a, a] : [a])).rejects.toThrow()
  expect(f.provider.getNetwork).not.toHaveBeenCalled()
})

it.each(['empty-catalog', 'gap', 'unmined', 'double-inclusion', 'finalized-relation'])('refuses incomplete or contradictory nonce history: %s', async kind => {
  const f = fixture(), a = await f.attempt()
  f.include(a.raw)
  if (kind === 'gap') f.state.nonce = 2
  if (kind === 'unmined') f.receipts.clear()
  if (kind === 'double-inclusion') f.include(await f.cancellation(a))
  if (kind === 'finalized-relation') f.state.finalizedNonce = 1
  await expect(f.backing(kind === 'empty-catalog' ? [] : [a])).rejects.toThrow()
})

it.each(['hash', 'from', 'to', 'gas-used', 'gas-price', 'status', 'future-block', 'orphan'])('rejects inconsistent inclusion evidence: %s', async kind => {
  const f = fixture(), a = await f.attempt(), receipt = f.include(a.raw)
  const change: Record<string, unknown> = {
    hash: { hash: id('wrong transaction') }, from: { from: f.recipient.address }, to: { to: f.operator.address },
    'gas-used': { gasUsed: 100_001n }, 'gas-price': { gasPrice: 11n }, status: { status: 2 },
    'future-block': { blockNumber: 21 }, orphan: { blockHash: id('orphan') },
  }
  Object.assign(receipt, change[kind])
  await expect(f.backing([a])).rejects.toThrow('canonical signed transaction')
})

it.each(['latest-code', 'finalized-code', 'latest-reorg', 'finalized-reorg'])('refuses changing state during verification: %s', async kind => {
  const f = fixture(), a = await f.attempt(); f.include(a.raw)
  if (kind === 'latest-code') f.state.code = '0xef0100'
  if (kind === 'finalized-code') f.state.finalizedCode = '0xef0100'
  if (kind.endsWith('reorg')) {
    vi.spyOn(f.provider, 'getTransactionReceipt').mockImplementation(async hash => {
      f.changed.set(kind === 'latest-reorg' ? f.state.head : f.state.finalized, id('reorg during receipt read'))
      return f.receipts.get(hash) ?? null
    })
  }
  await expect(f.backing([a])).rejects.toThrow(kind.endsWith('reorg') ? 'history changed after the balance read' : undefined)
})

it('binds exact raw candidates and maximum costs in an order-independent history catalog', async () => {
  const f = fixture(), a = await f.attempt(), b = await f.attempt(1), initial = nativeHistoryCatalog([], [], [a, b])
  expect(nativeHistoryCatalog([], [], [b, a])).toBe(initial)
  expect(nativeHistoryCatalog([], [], [{ ...a, maximumCost: a.maximumCost + 1n }, b])).not.toBe(initial)
  await f.cancellation(a)
  expect(nativeHistoryCatalog([], [], [a, b])).not.toBe(initial)
})

it('rejects overlapping settled history, oversized catalogs, and repeated nonces before RPC work', async () => {
  const f = fixture(), a = await f.attempt(), receipt = f.include(a.raw)
  await expect(verifyNativeBacking(f.provider, f.scope, f.ledgerId, [], [{ transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }], [a])).rejects.toThrow('unsettled operator scope')
  await expect(f.backing(Array.from({ length: 21 }, () => a))).rejects.toThrow('nonce catalog')
  expect(f.provider.getNetwork).not.toHaveBeenCalled()
})

it('deduplicates canonical checks for pending transactions included in the same block', async () => {
  const f = fixture(), a = await f.attempt(), b = await f.attempt(1)
  f.include(a.raw); f.include(b.raw)
  await f.backing([a, b])
  expect(vi.mocked(f.provider.getBlock).mock.calls.filter(([tag]) => tag === 11)).toHaveLength(1)
})

it.each([1, 56])('leaves chain %i backing unchanged and refuses pending outflow', async chainId => {
  chain.id = chainId
  const f = fixture(), a = await f.attempt()
  expect(nativeBackingEvidence(await f.backing())).toMatchObject({ available: f.state.balance, pendingOutflow: 0n })
  await expect(f.backing([a])).rejects.toThrow('only on Arbitrum')
  expect(f.provider.getTransactionReceipt).not.toHaveBeenCalled()
})

it.each([0, 1])('counts Base data and operator fees without releasing a failed payout, status %i', async status => {
  chain.id = 8453
  const f = fixture(), a = await f.attempt(0, 500_000n), receipt = f.include(a.raw, status)
  const raw = { transactionHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: toQuantity(receipt.blockNumber),
    status: toQuantity(status), gasUsed: toQuantity(receipt.gasUsed), effectiveGasPrice: toQuantity(receipt.gasPrice), l1Fee: '0x1f4' }
  f.provider.send = vi.fn(async method => method === 'eth_getTransactionReceipt' ? raw : toBeHex(30n, 32))
  expect(nativeBackingEvidence(await f.backing([a]))).toMatchObject({ available: f.state.balance,
    pendingOutflow: 63_530n + (status ? 500_000n : 0n) })
  raw.l1Fee = '0x100000'
  await expect(f.backing([a])).rejects.toThrow('reserved maximum')
  raw.l1Fee = undefined as unknown as string
  await expect(f.backing([a])).rejects.toThrow('fee evidence')
})

it('refuses Base type-4 pending transactions before RPC reads', async () => {
  chain.id = 8453
  const f = fixture(), a = await f.attempt(0, 0n, 4)
  await expect(f.backing([a])).rejects.toThrow('operator scope')
  expect(f.provider.getNetwork).not.toHaveBeenCalled()
})
