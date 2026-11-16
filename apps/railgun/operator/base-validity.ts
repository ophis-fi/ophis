import { getBytes, isHexString, toQuantity, Transaction, type JsonRpcProvider, type TransactionLike } from 'ethers'
import { assertCanonicalReceipt } from '../src/receipt-canonical'

type PriceOperator = '=' | '<='
type StoragePredicate = { type: 'storage'; params: { address: string; slot: string; op: PriceOperator; value: string; mask?: string } }
type BlockPredicate = { type: 'block_number'; params: { op: '<='; value: string } }
export interface BaseValidityPlan {
  unsigned: string; maximumCost: string; headNumber: number; headTimestamp: number;
  expiryBlock: number; feeExpiryMs: number; validity: (StoragePredicate | BlockPredicate)[]
}
const L1_BLOCK = '0x4200000000000000000000000000000000000015'
const GAS_ORACLE = '0x420000000000000000000000000000000000000f'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const SCALARS_MASK = ((1n << 64n) - 1n) << 64n
const OPERATOR_MASK = (1n << 96n) - 1n
const UINT256 = 1n << 256n
const MAX_BLOCK_WINDOW = 100
// Base mainnet L1Block v1.8.0, exact-match verified against base/contracts v8.4.0.
// https://github.com/base/contracts/blob/v8.4.0/src/L2/L1Block.sol
// https://basescan.org/address/0x8bde8f549f56d405f07e1aa15df9e1fc69839881#code
// Runtime keccak256: 0x3828c878b385799d77f7a600108743e04ec8f049bfc778ecd3941c86cf0164bb.
// GPO remains the Base v1.5.4 Jovian deployment (upgrades/src/jovian.rs:170).
const L1_IMPLEMENTATION = 0x8bde8f549f56d405f07e1aa15df9e1fc69839881n
const ORACLE_IMPLEMENTATION = 0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1n
const JOVIAN_FLAGS = 0x01010101n

function unsignedTransaction(value: string | TransactionLike<string>): Transaction {
  const tx = Transaction.from(value)
  if (tx.type !== 2 || tx.chainId !== 8453n || tx.isSigned() || tx.authorizationList?.length || (!tx.to && tx.data === '0x') ||
    tx.gasLimit <= 0n || tx.gasLimit > 30_000_000n || !tx.maxFeePerGas || !tx.maxPriorityFeePerGas ||
    tx.maxPriorityFeePerGas > tx.maxFeePerGas || getBytes(tx.unsignedSerialized).length > 262_144)
    throw new Error('Base validity requires a bounded unsigned type-2 transaction.')
  return tx
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value))
    throw new Error('Invalid Base validity quantity.')
  return BigInt(value)
}
function storage(address: string, slot: string, value: bigint, mask?: bigint, op: PriceOperator = '='): StoragePredicate {
  return { type: 'storage', params: { address, slot, op, value: toQuantity(value),
    ...(mask === undefined ? {} : { mask: toQuantity(mask) }) } }
}
function predicates(values: readonly bigint[], expiryBlock: number, priceOperator: PriceOperator): BaseValidityPlan['validity'] {
  return [storage(L1_BLOCK, '0x1', values[0], undefined, priceOperator), storage(L1_BLOCK, '0x3', values[1], SCALARS_MASK),
    storage(L1_BLOCK, '0x7', values[2], undefined, priceOperator), storage(L1_BLOCK, '0x8', values[3], OPERATOR_MASK),
    storage(L1_BLOCK, IMPLEMENTATION_SLOT, L1_IMPLEMENTATION),
    storage(GAS_ORACLE, IMPLEMENTATION_SLOT, ORACLE_IMPLEMENTATION), storage(GAS_ORACLE, '0x0', JOVIAN_FLAGS),
    { type: 'block_number', params: { op: '<=', value: toQuantity(expiryBlock) } }]
}
function predicateValues(validity: unknown, expiryBlock: number): { values: bigint[]; priceOperator: PriceOperator } {
  if (!Array.isArray(validity) || validity.length !== 8) throw new Error('Invalid Base validity predicates.')
  const values = validity.slice(0, 4).map(item => quantity(item?.params?.value))
  // Both shapes are deliberate: retained equality-based plans/bodies must remain byte-for-byte recoverable.
  const priceOperator = validity[0]?.params?.op
  if ((priceOperator !== '=' && priceOperator !== '<=') ||
    (values[1] & ~SCALARS_MASK) !== 0n || (values[3] & ~OPERATOR_MASK) !== 0n ||
    JSON.stringify(validity) !== JSON.stringify(predicates(values, expiryBlock, priceOperator)))
    throw new Error('Base validity predicates differ from the reviewed fee policy.')
  return { values, priceOperator }
}
function priceCeiling(value: bigint): bigint {
  // Twofold headroom tolerates L1-origin price changes. This is an enforced ceiling, not an inclusion forecast:
  // maximumCost charges these same upper values, and either price exceeding its ceiling excludes the transaction.
  const ceiling = value * 2n
  if (ceiling >= UINT256) throw new Error('Base full network cost exceeds its permitted range.')
  return ceiling
}
function maximumCost(tx: Transaction, values: readonly bigint[]): bigint {
  // Signed type-2 RLP adds at most 67 signature bytes and one list-prefix byte.
  const size = BigInt(getBytes(tx.unsignedSerialized).length + 68)
  // Every match saves >=1 byte, covering the extra literal-run header; literals add ceil(n/32).
  // https://github.com/base/base/blob/v1.5.4/crates/common/flz/src/flz.rs#L51-L124
  const flzBound = size + (size + 31n) / 32n
  const regression = flzBound * 836_500n - 42_585_600n
  const estimatedSize = regression > 100_000_000n ? regression : 100_000_000n
  const baseScalar = (values[1] >> 96n) & 0xffffffffn, blobScalar = (values[1] >> 64n) & 0xffffffffn
  const operatorScalar = values[3] >> 64n, operatorConstant = values[3] & ((1n << 64n) - 1n)
  // Fjord/Jovian schedule shared by reviewed Base upgrades through Everest; later fee rules require requalification.
  // https://github.com/base/base/blob/v1.5.4/crates/common/l1-fees/src/params.rs#L146-L198
  const l1Cost = estimatedSize * (baseScalar * values[0] * 16n + blobScalar * values[2]) / 1_000_000_000_000n
  const cost = tx.gasLimit * tx.maxFeePerGas! + l1Cost + tx.gasLimit * operatorScalar * 100n + operatorConstant
  if (cost <= 0n || cost >= UINT256) throw new Error('Base full network cost exceeds its permitted range.')
  return cost
}
function expiry(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid Base validity expiry.')
  return Number(value)
}

/** Validate persisted plans too: storage predicates enforce the same parameters used to reserve the full cost. */
export function validateBaseValidityPlan(value: unknown, expectedUnsigned?: string): Readonly<BaseValidityPlan> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing Base validity plan.')
  const plan = value as BaseValidityPlan, tx = unsignedTransaction(plan.unsigned)
  const headNumber = expiry(plan.headNumber), headTimestamp = expiry(plan.headTimestamp), expiryBlock = expiry(plan.expiryBlock)
  if (tx.unsignedSerialized !== plan.unsigned || (expectedUnsigned !== undefined && expectedUnsigned !== plan.unsigned) ||
    !Number.isSafeInteger(plan.feeExpiryMs) || expiryBlock <= headNumber || expiryBlock > headNumber + MAX_BLOCK_WINDOW ||
    headTimestamp * 1000 + (expiryBlock - headNumber) * 2000 > plan.feeExpiryMs)
    throw new Error('Base validity plan does not match its unsigned transaction or quote expiry.')
  const { values, priceOperator } = predicateValues(plan.validity, expiryBlock)
  const canonical: BaseValidityPlan = { unsigned: tx.unsignedSerialized, maximumCost: maximumCost(tx, values).toString(),
    headNumber, headTimestamp, expiryBlock, feeExpiryMs: plan.feeExpiryMs, validity: predicates(values, expiryBlock, priceOperator) }
  if (JSON.stringify(plan) !== JSON.stringify(canonical)) throw new Error('Base validity plan cost or encoding changed.')
  for (const predicate of canonical.validity) { Object.freeze(predicate.params); Object.freeze(predicate) }
  Object.freeze(canonical.validity)
  return Object.freeze(canonical)
}

/** Reads contain only fixed fee contracts and a block hash; signed execution bytes never reach the read RPC. */
export async function prepareBaseValidity(provider: Pick<JsonRpcProvider, 'getNetwork' | 'getBlock' | 'send'>,
  transaction: string | TransactionLike<string>, feeExpiryMs: number): Promise<Readonly<BaseValidityPlan>> {
  const tx = unsignedTransaction(transaction)
  if (!Number.isSafeInteger(feeExpiryMs) || feeExpiryMs <= Date.now() || (await provider.getNetwork()).chainId !== 8453n)
    throw new Error('Base validity requires the selected chain and an unexpired authenticated quote.')
  const head = await provider.getBlock('latest')
  if (!head || !Number.isSafeInteger(head.number) || head.number < 1 || !isHexString(head.hash, 32) ||
    !Number.isSafeInteger(head.timestamp) || Math.abs(Date.now() - head.timestamp * 1000) > 45_000)
    throw new Error('A fresh canonical Base head is required.')
  const expiryBlock = head.number + Math.min(MAX_BLOCK_WINDOW, Math.floor((feeExpiryMs - head.timestamp * 1000) / 2000))
  if (!Number.isSafeInteger(expiryBlock) || expiryBlock <= head.number ||
    head.timestamp * 1000 + (expiryBlock - head.number) * 2000 <= Date.now())
    throw new Error('Base quote expires before a bounded inclusion window.')
  const template = predicates([0n, 0n, 0n, 0n], expiryBlock, '<=').slice(0, 7) as StoragePredicate[]
  const words = await Promise.all(template.map(async predicate => {
    const result: unknown = await provider.send('eth_getStorageAt', [predicate.params.address, predicate.params.slot,
      { blockHash: head.hash, requireCanonical: true }]).catch(() => {
      throw new Error('Base historical fee storage is unavailable.')
    })
    if (typeof result !== 'string' || !isHexString(result, 32)) throw new Error('Base historical fee storage is unavailable.')
    return BigInt(result)
  }))
  if (words[4] !== L1_IMPLEMENTATION || words[5] !== ORACLE_IMPLEMENTATION || words[6] !== JOVIAN_FLAGS)
    throw new Error('Base fee implementation or activation differs from the reviewed mainnet policy.')
  await assertCanonicalReceipt(provider, { blockNumber: head.number, blockHash: head.hash! }).catch(() => {
    throw new Error('Base fee head changed during verification.')
  })
  const values = [priceCeiling(words[0]), words[1] & SCALARS_MASK, priceCeiling(words[2]), words[3] & OPERATOR_MASK]
  return validateBaseValidityPlan({ unsigned: tx.unsignedSerialized, maximumCost: maximumCost(tx, values).toString(),
    headNumber: head.number, headTimestamp: head.timestamp, expiryBlock, feeExpiryMs, validity: predicates(values, expiryBlock, '<=') })
}
function body(raw: string, validity: BaseValidityPlan['validity']): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'base_sendRawTransactionValidity', params: [raw, { validity }] })
}
export function createBaseValidityBody(raw: string, value: unknown): string {
  const tx = Transaction.from(raw), plan = validateBaseValidityPlan(value, tx.unsignedSerialized)
  if (!tx.isSigned() || tx.serialized !== raw)
    throw new Error('Base submission requires its exact signed envelope and validity plan.')
  return body(raw, plan.validity)
}
export function readBaseValidityBody(serialized: string, expectedRaw?: string): {
  raw: string; hash: string; maximumNetworkCost: bigint; expiryBlock: number
} {
  try { return parseBaseValidityBody(serialized, expectedRaw) }
  catch { throw new Error('Base validity envelope changed or has invalid encoding.') }
}
function parseBaseValidityBody(serialized: string, expectedRaw?: string): {
  raw: string; hash: string; maximumNetworkCost: bigint; expiryBlock: number
} {
  const parsed = JSON.parse(serialized), raw = parsed?.params?.[0]
  if (typeof raw !== 'string' || (expectedRaw !== undefined && raw !== expectedRaw)) throw new Error('Base validity transaction changed.')
  const tx = Transaction.from(raw), unsigned = unsignedTransaction(tx.unsignedSerialized), validity = parsed?.params?.[1]?.validity
  if (!tx.isSigned() || tx.serialized !== raw || !Array.isArray(validity) || validity.length !== 8)
    throw new Error('Invalid Base validity signed envelope.')
  const expiryBlock = expiry(Number(quantity(validity[7]?.params?.value)))
  const { values, priceOperator } = predicateValues(validity, expiryBlock)
  if (serialized !== body(raw, predicates(values, expiryBlock, priceOperator))) throw new Error('Base validity envelope encoding changed.')
  return { raw, hash: tx.hash!, maximumNetworkCost: maximumCost(unsigned, values), expiryBlock }
}
export function assertBaseValidityUnexpired(serialized: string, raw: string, latestBlock: bigint): void {
  const plan = readBaseValidityBody(serialized, raw)
  if (latestBlock < 0n || latestBlock >= BigInt(plan.expiryBlock))
    throw new Error('The retained Base validity envelope expired; preserve its signed bytes and nonce hold.')
}
