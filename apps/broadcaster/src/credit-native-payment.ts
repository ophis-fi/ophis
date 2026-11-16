import { createHash } from 'node:crypto'
import { getAddress, isHexString, Transaction, ZeroAddress, type JsonRpcProvider } from 'ethers'
import { NATIVE_CREDIT_CHAINS, nativeCreditData, type CreditScope } from '../../railgun/credit-protocol'
import { CHAIN } from './config'
import { finalizedCreditEvidence, finalizedCreditReceipt } from './credit-payment'
import { assertTraceSuccess } from './transaction'
import { receiptNetworkCost } from '../../railgun/network-fee'

export interface NativeDepositAnchor {
  paymentId: string; owner: string; transactionHash: string; blockNumber: number; blockHash: string; amount: string
}
export interface NativeSettlementAnchor { transactionHash: string; blockNumber: number; blockHash: string }
export interface NativePendingAttempt { nonce: number; raw: string; cancellations: readonly string[]; maximumCost: bigint }
export interface VerifiedNativeDeposit { readonly kind: 'verified-native-credit-deposit' }
export interface NativeCreditBacking { readonly kind: 'verified-native-credit-backing' }
interface DepositDetails extends NativeDepositAnchor { ledgerId: string; scope: string; checkedAt: number }
interface BackingDetails { available: bigint; pendingOutflow: bigint; nonce: number; blockNumber: number; blockHash: string;
  checkedAt: number; ledgerId: string; scope: string; catalog: string }
const payments = new WeakMap<VerifiedNativeDeposit, Readonly<DepositDetails>>()
const balances = new WeakMap<NativeCreditBacking, Readonly<BackingDetails>>()
const checkpoints = new WeakMap<JsonRpcProvider, Map<string, { number: number; hash: string; anchors: Set<string> }>>()
const identifier = (value: string): string => {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) throw new Error('Invalid native credit identifier.')
  return value.toLowerCase()
}
export function nativeScope(scope: CreditScope, ledgerId: string): string {
  if (scope.funding !== 'native' || !NATIVE_CREDIT_CHAINS.includes(scope.chainId) || BigInt(scope.chainId) !== CHAIN ||
    getAddress(scope.operator) === ZeroAddress || getAddress(scope.recipient) !== getAddress(scope.operator) ||
    getAddress(scope.token) !== ZeroAddress) throw new Error('Native credit requires an explicit native ledger scope.')
  identifier(ledgerId)
  return JSON.stringify([scope.chainId, getAddress(scope.operator), getAddress(scope.recipient), ZeroAddress, 'native'])
}
function fresh<T extends { checkedAt: number }>(value: T | undefined): T {
  if (!value || value.checkedAt > Date.now() || Date.now() - value.checkedAt > 45_000)
    throw new Error('Fresh verified native credit evidence is required.')
  return value
}
export function nativeDepositEvidence(proof: VerifiedNativeDeposit): Readonly<DepositDetails> { return fresh(payments.get(proof)) }
export function nativeBackingEvidence(proof: NativeCreditBacking): Readonly<BackingDetails> { return fresh(balances.get(proof)) }
export function nativeDepositCatalog(anchors: readonly NativeDepositAnchor[]): string {
  const normalized = anchors.map(anchor => {
    if (!Number.isSafeInteger(anchor.blockNumber) || anchor.blockNumber < 0 ||
      !/^[1-9][0-9]{0,77}$/.test(anchor.amount) || BigInt(anchor.amount) >= 2n ** 256n || getAddress(anchor.owner) === ZeroAddress)
      throw new Error('Invalid native deposit history.')
    return JSON.stringify([identifier(anchor.paymentId), getAddress(anchor.owner), identifier(anchor.transactionHash),
      anchor.blockNumber, identifier(anchor.blockHash), anchor.amount])
  }).sort()
  if (new Set(normalized).size !== normalized.length) throw new Error('Duplicate native deposit history.')
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
function pendingTransactions(pending: readonly NativePendingAttempt[]) {
  if (pending.length > 20 || new Set(pending.map(item => item.nonce)).size !== pending.length)
    throw new Error('Invalid native pending nonce catalog.')
  return pending.map(item => {
    if (!Number.isSafeInteger(item.nonce) || item.nonce < 0 || typeof item.maximumCost !== 'bigint' ||
      item.maximumCost <= 0n || item.maximumCost >= 2n ** 256n || !Array.isArray(item.cancellations))
      throw new Error('Invalid native pending attempt.')
    const transactions = [item.raw, ...item.cancellations].map((raw, index) => {
      if (typeof raw !== 'string' || !isHexString(raw)) throw new Error('Missing signed native pending transaction.')
      const tx = Transaction.from(raw), price = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
      if (!tx.isSigned() || tx.serialized !== raw.toLowerCase() || ![0, 1, 2, 4].includes(tx.type ?? -1) ||
        !tx.to || tx.nonce !== item.nonce || tx.gasLimit <= 0n || price <= 0n || tx.gasLimit * price > item.maximumCost ||
        (tx.maxPriorityFeePerGas ?? 0n) > price || (tx.value > 0n && tx.to === tx.from) ||
        (index > 0 && (tx.type !== 2 || tx.to !== tx.from || tx.data !== '0x' || tx.value !== 0n || tx.authorizationList?.length)))
        throw new Error('Invalid signed native pending transaction or cancellation.')
      return tx
    })
    if (new Set(transactions.map(tx => tx.hash)).size !== transactions.length)
      throw new Error('Duplicate native pending transaction.')
    return { nonce: item.nonce, maximumCost: item.maximumCost, transactions }
  })
}
export function nativeHistoryCatalog(deposits: readonly NativeDepositAnchor[], settlements: readonly NativeSettlementAnchor[],
  pending: readonly NativePendingAttempt[] = []): string {
  const outcomes = settlements.map(item => {
    if (!Number.isSafeInteger(item.blockNumber) || item.blockNumber < 0) throw new Error('Invalid native settlement history.')
    return JSON.stringify([identifier(item.transactionHash), item.blockNumber, identifier(item.blockHash)])
  }).sort()
  if (new Set(outcomes).size !== outcomes.length) throw new Error('Duplicate native settlement history.')
  const attempts = pendingTransactions(pending).map(item => JSON.stringify([item.nonce, item.maximumCost.toString(),
    item.transactions[0].serialized, item.transactions.slice(1).map(tx => tx.serialized).sort()])).sort()
  return createHash('sha256').update(JSON.stringify([nativeDepositCatalog(deposits), outcomes, ...(attempts.length ? [attempts] : [])])).digest('hex')
}
export function assertNativeRefundTrace(trace: unknown, expected: { from: string; to: string; value: bigint }): void {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) throw new Error('Missing native refund execution trace.')
  const root = trace as Record<string, unknown>
  if (root.type !== 'CALL' || typeof root.from !== 'string' || typeof root.to !== 'string' || root.input !== '0x' ||
    typeof root.value !== 'string' || !/^0x[0-9a-f]+$/i.test(root.value) || BigInt(root.value) !== expected.value ||
    getAddress(root.from) !== getAddress(expected.from) || getAddress(root.to) !== getAddress(expected.to))
    throw new Error('Native refund trace does not match the approved payout.')
  assertTraceSuccess(trace)
}
async function read<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native credit read timed out.')), 15_000)
  })]) } finally { if (timer) clearTimeout(timer) }
}
/** Direct type 0/2 funding only; sender delegation cannot execute on this path. Internal calls and self-transfers never mint credit. */
export async function verifyNativeDeposit(provider: JsonRpcProvider, scope: CreditScope, ledgerId: string,
  owner: string, paymentId: string, transactionHash: string): Promise<VerifiedNativeDeposit> {
  const scopeKey = nativeScope(scope, ledgerId), claimant = getAddress(owner)
  if (claimant === ZeroAddress) throw new Error('Invalid native credit owner.')
  paymentId = identifier(paymentId); transactionHash = identifier(transactionHash)
  const receipt = await read(finalizedCreditReceipt(provider, transactionHash)), evidence = finalizedCreditEvidence(receipt)
  const tx = await read(provider.getTransaction(transactionHash)), operator = getAddress(scope.operator)
  if (!tx || tx.hash.toLowerCase() !== transactionHash || tx.chainId !== CHAIN || ![0, 2].includes(tx.type) ||
    (tx.authorizationList?.length ?? 0) !== 0 || !tx.to || getAddress(tx.to) !== operator || getAddress(tx.from) === operator ||
    getAddress(tx.from) === ZeroAddress || tx.value <= 0n || tx.value >= 2n ** 256n ||
    tx.data.toLowerCase() !== nativeCreditData(scope, ledgerId, claimant, paymentId).toLowerCase() ||
    tx.blockNumber !== evidence.blockNumber || tx.blockHash !== evidence.blockHash || evidence.status !== 1 ||
    receipt.from !== tx.from || receipt.to !== tx.to)
    throw new Error('Native funding transaction does not match its finalized owner-bound payment.')
  const [operatorCode, previousCode, canonical] = await Promise.all([
    read(provider.getCode(operator, evidence.blockNumber)),
    read(provider.getCode(operator, Math.max(0, evidence.blockNumber - 1))), read(provider.getBlock(evidence.blockNumber)),
  ])
  if (operatorCode !== '0x' || previousCode !== '0x' || canonical?.hash !== evidence.blockHash)
    throw new Error('Native funding requires an undelegated operator on the canonical chain.')
  const proof: VerifiedNativeDeposit = Object.freeze({ kind: 'verified-native-credit-deposit' })
  payments.set(proof, Object.freeze({ paymentId, owner: claimant, transactionHash, blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash, amount: tx.value.toString(), ledgerId: identifier(ledgerId), scope: scopeKey, checkedAt: Date.now() }))
  return proof
}
/** Pin current spendable native balance and recheck all credited origins through a canonical finalized checkpoint. */
export async function verifyNativeBacking(provider: JsonRpcProvider, scope: CreditScope, ledgerId: string,
  anchors: readonly NativeDepositAnchor[], settlements: readonly NativeSettlementAnchor[] = [],
  pending: readonly NativePendingAttempt[] = []): Promise<NativeCreditBacking> {
  const scopeKey = nativeScope(scope, ledgerId), catalog = nativeHistoryCatalog(anchors, settlements, pending)
  const attempts = pendingTransactions(pending), operator = getAddress(scope.operator)
  if (pending.length && ![42161, 8453].includes(scope.chainId)) throw new Error('Pending native backing is available only on Arbitrum and Base.')
  for (const attempt of attempts) for (const tx of attempt.transactions) {
    if (tx.from !== operator || tx.chainId !== CHAIN || (scope.chainId === 8453 && tx.type !== 2) ||
      settlements.some(item => item.transactionHash.toLowerCase() === tx.hash))
      throw new Error('Native pending transaction does not match its unsettled operator scope.')
  }
  if ((await read(provider.getNetwork())).chainId !== CHAIN) throw new Error('Native backing is on another chain.')
  const finalized = await read(provider.getBlock('finalized'))
  if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < 0 || !isHexString(finalized.hash, 32))
    throw new Error('Missing native finalized history anchor.')
  const blockReads = new Map<number, ReturnType<JsonRpcProvider['getBlock']>>()
  const canonicalBlock = (number: number) => {
    let result = blockReads.get(number)
    if (!result) { result = read(provider.getBlock(number)); blockReads.set(number, result) }
    return result
  }
  let cache = checkpoints.get(provider)
  if (!cache) { cache = new Map(); checkpoints.set(provider, cache) }
  const cacheKey = `${scopeKey}:${identifier(ledgerId)}`, previous = cache.get(cacheKey)
  let known = new Set<string>()
  if (previous) {
    const old = await canonicalBlock(previous.number)
    if (old?.hash === previous.hash && finalized.number >= previous.number) known = previous.anchors
    else cache.delete(cacheKey)
  }
  const next = new Set<string>(), historyBlocks = new Map<number, string>()
  for (const { anchor, key } of [
    ...anchors.map(anchor => ({ anchor, key: nativeDepositCatalog([anchor]) })),
    ...settlements.map(anchor => ({ anchor, key: nativeHistoryCatalog([], [anchor]) })),
  ]) {
    next.add(key)
    if (anchor.blockNumber > finalized.number) throw new Error('Credited native funding is no longer finalized.')
    if (!known.has(key)) {
      const expected = historyBlocks.get(anchor.blockNumber)
      if (expected && expected !== anchor.blockHash) throw new Error('Conflicting native history anchors.')
      historyBlocks.set(anchor.blockNumber, anchor.blockHash)
    }
  }
  const blocks = [...historyBlocks]
  for (let offset = 0; offset < blocks.length; offset += 8) await Promise.all(blocks.slice(offset, offset + 8).map(async ([number, hash]) => {
    if ((await canonicalBlock(number))?.hash !== hash) throw new Error('Credited native payment changed canonical history.')
  }))
  if ((await read(provider.getBlock(finalized.number)))?.hash !== finalized.hash) throw new Error('Native finalized history changed during verification.')
  cache.set(cacheKey, { number: finalized.number, hash: finalized.hash!, anchors: next })
  const head = await read(provider.getBlock('latest'))
  if (!head || !isHexString(head.hash, 32) || !Number.isSafeInteger(head.number) || head.number < finalized.number ||
    !Number.isSafeInteger(head.timestamp) || Math.abs(Date.now() - head.timestamp * 1000) > 45_000)
    throw new Error('Fresh native backing head is required.')
  const [available, nonce, code, canonical, finalizedNonce, finalizedCode] = await Promise.all([read(provider.getBalance(operator, head.number)),
    read(provider.getTransactionCount(operator, head.number)), read(provider.getCode(operator, head.number)), canonicalBlock(head.number),
    [42161, 8453].includes(scope.chainId) ? read(provider.getTransactionCount(operator, finalized.number)) : undefined,
    [42161, 8453].includes(scope.chainId) ? read(provider.getCode(operator, finalized.number)) : undefined])
  if (available < 0n || available >= 2n ** 256n || !Number.isSafeInteger(nonce) || nonce < 0 || code !== '0x' || canonical?.hash !== head.hash)
    throw new Error('Native balance, nonce or operator code changed during verification.')
  let pendingOutflow = 0n
  if ([42161, 8453].includes(scope.chainId)) {
    if (!Number.isSafeInteger(finalizedNonce) || finalizedNonce! < 0 || finalizedNonce! > nonce || finalizedCode !== '0x' ||
      nonce - finalizedNonce! > attempts.length || attempts.some(item => item.nonce >= nonce))
      throw new Error('Native pending catalog does not cover the operator nonce history.')
    const nonces = new Set(attempts.map(item => item.nonce))
    for (let value = finalizedNonce!; value < nonce; value++) if (!nonces.has(value))
      throw new Error('Unknown native operator nonce consumption.')
    const candidates = attempts.flatMap(attempt => attempt.transactions.map(tx => ({ attempt, tx })))
    const included = new Set<number>()
    for (let offset = 0; offset < candidates.length; offset += 8) {
      const receipts = await Promise.all(candidates.slice(offset, offset + 8).map(async ({ attempt, tx }) => ({
        attempt, tx, receipt: await read(provider.getTransactionReceipt(tx.hash!)),
      })))
      for (const { attempt, tx, receipt } of receipts) {
        if (!receipt) continue
        if (included.has(attempt.nonce) || receipt.hash !== tx.hash || receipt.from !== operator || receipt.to !== tx.to ||
          !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > head.number ||
          !isHexString(receipt.blockHash, 32) || (receipt.status !== 0 && receipt.status !== 1) ||
          typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n || receipt.gasUsed > tx.gasLimit ||
          typeof receipt.gasPrice !== 'bigint' || receipt.gasPrice <= 0n || receipt.gasPrice > (tx.maxFeePerGas ?? tx.gasPrice!) ||
          (receipt.blockNumber <= finalized.number) !== (attempt.nonce < finalizedNonce!) ||
          (await canonicalBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
          throw new Error('Native pending receipt does not match its canonical signed transaction.')
        included.add(attempt.nonce)
        const cost = await read(receiptNetworkCost(provider, receipt, scope.chainId))
        if (cost > attempt.maximumCost) throw new Error('Native pending cost exceeds its reserved maximum.')
        pendingOutflow += cost + (receipt.status === 1 ? tx.value : 0n)
      }
    }
    if (included.size !== attempts.length || pendingOutflow >= 2n ** 256n)
      throw new Error('Every native pending attempt must have a canonical inclusion.')
  }
  // Block-number state reads can race a reorg; recheck both ancestry and the state head after they finish.
  if ((await read(provider.getBlock(head.number)))?.hash !== head.hash ||
    (await read(provider.getBlock(finalized.number)))?.hash !== finalized.hash)
    throw new Error('Native canonical history changed after the balance read.')
  const proof: NativeCreditBacking = Object.freeze({ kind: 'verified-native-credit-backing' })
  balances.set(proof, Object.freeze({ available, pendingOutflow, nonce, blockNumber: head.number, blockHash: head.hash!,
    checkedAt: Math.min(Date.now(), head.timestamp * 1000), ledgerId: identifier(ledgerId), scope: scopeKey, catalog }))
  return proof
}
