import { createHash } from 'node:crypto'
import { getAddress, isHexString, ZeroAddress, type JsonRpcProvider } from 'ethers'
import { nativeCreditData, type CreditScope } from '../../railgun/credit-protocol'
import { CHAIN } from './config'
import { finalizedCreditEvidence, finalizedCreditReceipt } from './credit-payment'
import { assertTraceSuccess } from './transaction'

export interface NativeDepositAnchor {
  paymentId: string; owner: string; transactionHash: string; blockNumber: number; blockHash: string; amount: string
}
export interface NativeSettlementAnchor { transactionHash: string; blockNumber: number; blockHash: string }
export interface VerifiedNativeDeposit { readonly kind: 'verified-native-credit-deposit' }
export interface NativeCreditBacking { readonly kind: 'verified-native-credit-backing' }
interface DepositDetails extends NativeDepositAnchor { ledgerId: string; scope: string; checkedAt: number }
interface BackingDetails { available: bigint; nonce: number; blockNumber: number; blockHash: string;
  checkedAt: number; ledgerId: string; scope: string; catalog: string }
const payments = new WeakMap<VerifiedNativeDeposit, Readonly<DepositDetails>>()
const balances = new WeakMap<NativeCreditBacking, Readonly<BackingDetails>>()
const checkpoints = new WeakMap<JsonRpcProvider, Map<string, { number: number; hash: string; anchors: Set<string> }>>()
const identifier = (value: string): string => {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) throw new Error('Invalid native credit identifier.')
  return value.toLowerCase()
}
export function nativeScope(scope: CreditScope, ledgerId: string): string {
  if (scope.funding !== 'native' || ![1, 56].includes(scope.chainId) || BigInt(scope.chainId) !== CHAIN ||
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
export function nativeHistoryCatalog(deposits: readonly NativeDepositAnchor[], settlements: readonly NativeSettlementAnchor[]): string {
  const outcomes = settlements.map(item => {
    if (!Number.isSafeInteger(item.blockNumber) || item.blockNumber < 0) throw new Error('Invalid native settlement history.')
    return JSON.stringify([identifier(item.transactionHash), item.blockNumber, identifier(item.blockHash)])
  }).sort()
  if (new Set(outcomes).size !== outcomes.length) throw new Error('Duplicate native settlement history.')
  return createHash('sha256').update(JSON.stringify([nativeDepositCatalog(deposits), outcomes])).digest('hex')
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
  anchors: readonly NativeDepositAnchor[], settlements: readonly NativeSettlementAnchor[] = []): Promise<NativeCreditBacking> {
  const scopeKey = nativeScope(scope, ledgerId), catalog = nativeHistoryCatalog(anchors, settlements)
  if ((await read(provider.getNetwork())).chainId !== CHAIN) throw new Error('Native backing is on another chain.')
  const finalized = await read(provider.getBlock('finalized'))
  if (!finalized || !Number.isSafeInteger(finalized.number) || finalized.number < 0 || !isHexString(finalized.hash, 32))
    throw new Error('Missing native finalized history anchor.')
  let cache = checkpoints.get(provider)
  if (!cache) { cache = new Map(); checkpoints.set(provider, cache) }
  const cacheKey = `${scopeKey}:${identifier(ledgerId)}`, previous = cache.get(cacheKey)
  let known = new Set<string>()
  if (previous) {
    const old = await read(provider.getBlock(previous.number))
    if (old?.hash === previous.hash && finalized.number >= previous.number) known = previous.anchors
    else cache.delete(cacheKey)
  }
  const next = new Set<string>(), pending = new Map<number, string>()
  for (const { anchor, key } of [
    ...anchors.map(anchor => ({ anchor, key: nativeDepositCatalog([anchor]) })),
    ...settlements.map(anchor => ({ anchor, key: nativeHistoryCatalog([], [anchor]) })),
  ]) {
    next.add(key)
    if (anchor.blockNumber > finalized.number) throw new Error('Credited native funding is no longer finalized.')
    if (!known.has(key)) {
      const expected = pending.get(anchor.blockNumber)
      if (expected && expected !== anchor.blockHash) throw new Error('Conflicting native history anchors.')
      pending.set(anchor.blockNumber, anchor.blockHash)
    }
  }
  const blocks = [...pending]
  for (let offset = 0; offset < blocks.length; offset += 8) await Promise.all(blocks.slice(offset, offset + 8).map(async ([number, hash]) => {
    if ((await read(provider.getBlock(number)))?.hash !== hash) throw new Error('Credited native payment changed canonical history.')
  }))
  if ((await read(provider.getBlock(finalized.number)))?.hash !== finalized.hash) throw new Error('Native finalized history changed during verification.')
  cache.set(cacheKey, { number: finalized.number, hash: finalized.hash!, anchors: next })
  const head = await read(provider.getBlock('latest'))
  if (!head || !isHexString(head.hash, 32) || !Number.isSafeInteger(head.number) || head.number < finalized.number ||
    !Number.isSafeInteger(head.timestamp) || Math.abs(Date.now() - head.timestamp * 1000) > 45_000)
    throw new Error('Fresh native backing head is required.')
  const operator = getAddress(scope.operator)
  const [available, nonce, code, canonical] = await Promise.all([read(provider.getBalance(operator, head.number)),
    read(provider.getTransactionCount(operator, head.number)), read(provider.getCode(operator, head.number)), read(provider.getBlock(head.number))])
  if (available < 0n || available >= 2n ** 256n || !Number.isSafeInteger(nonce) || nonce < 0 || code !== '0x' || canonical?.hash !== head.hash)
    throw new Error('Native balance, nonce or operator code changed during verification.')
  // Block-number state reads can race a reorg; recheck both ancestry and the state head after they finish.
  if ((await read(provider.getBlock(head.number)))?.hash !== head.hash ||
    (await read(provider.getBlock(finalized.number)))?.hash !== finalized.hash)
    throw new Error('Native canonical history changed after the balance read.')
  const proof: NativeCreditBacking = Object.freeze({ kind: 'verified-native-credit-backing' })
  balances.set(proof, Object.freeze({ available, nonce, blockNumber: head.number, blockHash: head.hash!,
    checkedAt: Math.min(Date.now(), head.timestamp * 1000), ledgerId: identifier(ledgerId), scope: scopeKey, catalog }))
  return proof
}
