import { createHash } from 'node:crypto'
import { getAddress, Interface, isHexString, verifyAuthorization, ZeroAddress, type JsonRpcProvider,
  type TransactionReceipt } from 'ethers'
import { CHAIN, CHAIN_ID, NETWORK, TOKENS } from './config'
import { finalizedCreditEvidence, finalizedCreditReceipt } from './credit-payment'
import { PROXY } from './transaction'
import { object } from './wire'

// ANON 0.12.4 signed registry/ABI; code independently checked on Ethereum and BNB.
// See the release evidence's anon-gateway-bnb-runtime-verification.json and CRX3 provenance.
export const ANON_COLLECTION_GATEWAY = getAddress('0xB25058Ccb45E0CD7d588e18e23A1E02B85F59f54')
const GATEWAY_CODE_SHA256 = 'aa2480c61c4b5a3f2da5eb312dd29fec3df53796fb30a2b3ea991ab2b6073896'
// This immutable helper address is embedded twice in the pinned gateway runtime.
export const ANON_COLLECTION_HELPER = getAddress('0x5be602a2cbdfa005efc5317e35d99d2877286f86')
const HELPER_CODE_SHA256 = '4bcd1cd15cfcd6b0ba77331615a9f418102fc05e8f8715d5564ee420a1744833'
const HELPER_SELECTOR = '0x2898bb17'
// Signed ANON 0.12.4 fee mirror and deployed gateway: charged after the RAILGUN unshield fee.
export const ANON_COLLECTION_BASE_FEE_BPS = 13n
export const ANON_COLLECTION_ABI = new Interface([
  `function unshield(${PROXY.getFunction('transact')!.inputs[0].format('full')}, (address recipient, uint16 integratorFeeBP, address integratorFeeRecipient, bool unwrapNative, bool unwrapERC1155, bytes erc1155RecipientData) _data)`,
  'function baseFeeBP() view returns (uint256)',
])

export interface VerifiedNativeCollection { readonly verifiedNativeCollection: true }
interface NativeEvidence {
  transactionHash: string; blockHash: string; blockNumber: number; grossUnshield: bigint
  nativeReceived: bigint; recipient: string; token: string; gateway: string
}
const proofs = new WeakMap<VerifiedNativeCollection, Readonly<NativeEvidence>>()
export function nativeCollectionEvidence(proof: VerifiedNativeCollection): Readonly<NativeEvidence> {
  const evidence = proofs.get(proof)
  if (!evidence) throw new Error('Verified canonical ANON native collection evidence is required.')
  return evidence
}

interface Frame {
  type: string; from: string; to: string; input: string; value: bigint; failed: boolean
  parent?: Frame; calls: Frame[]
}
const traceFields = new Set(['type', 'from', 'to', 'input', 'output', 'value', 'gas', 'gasUsed', 'error', 'revertReason', 'calls'])
function parseTrace(raw: unknown): { root: Frame; frames: Frame[] } {
  const frames: Frame[] = []
  let bytes = 0
  const parse = (node: unknown, parent?: Frame, depth = 0): Frame => {
    if (!object(node) || depth > 32 || frames.length >= 1024 || Object.keys(node).length > traceFields.size ||
      Object.keys(node).some((key) => !traceFields.has(key)) || typeof node.type !== 'string' ||
      !['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2'].includes(node.type) ||
      typeof node.from !== 'string' || typeof node.to !== 'string' || typeof node.input !== 'string' ||
      !isHexString(node.input) || node.input.length > 524_290 ||
      (node.calls !== undefined && (!Array.isArray(node.calls) || node.calls.length > 1024))) throw new Error('ANON collection trace is malformed or exceeds its bounds.')
    for (const [key, value] of Object.entries(node)) {
      if (key === 'calls') continue
      if (typeof value !== 'string' || value.length > 524_290) throw new Error('ANON collection trace has invalid scalar fields.')
      bytes += value.length
      if (bytes > 8 * 1024 * 1024) throw new Error('ANON collection trace exceeds its size limit.')
    }
    const value = node.value === undefined ? '0x0' : node.value
    if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) throw new Error('Invalid native trace value.')
    const frame: Frame = { type: node.type, from: getAddress(node.from), to: getAddress(node.to),
      input: node.input.toLowerCase(), value: BigInt(value), failed: !!parent?.failed || node.error !== undefined,
      parent, calls: [] }
    frames.push(frame)
    frame.calls = ((node.calls ?? []) as unknown[]).map((child) => parse(child, frame, depth + 1))
    return frame
  }
  return { root: parse(raw), frames }
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ANON native collection verification timed out.')), 15_000)
    })])
  } finally { clearTimeout(timer) }
}
function pinnedCode(code: string, helper = false): void {
  if (!isHexString(code) || code.length !== (helper ? 20_674 : 44_442) ||
    createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex') !== (helper ? HELPER_CODE_SHA256 : GATEWAY_CODE_SHA256))
    throw new Error('ANON collection gateway or helper does not match its approved runtime.')
}
/** Quotes may use only the same deployed gateway and fee policy accepted by final collection verification. */
export async function readAnonCollectionBaseFee(provider: JsonRpcProvider): Promise<bigint> {
  const [code, encoded] = await bounded(Promise.all([
    provider.getCode(ANON_COLLECTION_GATEWAY),
    provider.call({ to: ANON_COLLECTION_GATEWAY, data: ANON_COLLECTION_ABI.encodeFunctionData('baseFeeBP') }),
  ]))
  pinnedCode(code)
  if (!isHexString(encoded, 32) || ANON_COLLECTION_ABI.decodeFunctionResult('baseFeeBP', encoded)[0] !== ANON_COLLECTION_BASE_FEE_BPS)
    throw new Error('ANON collection gateway base fee differs from its approved 13 bps policy.')
  return ANON_COLLECTION_BASE_FEE_BPS
}
function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const normalized = actual.map((item) => item.toLowerCase())
  return normalized.length === expected.length && new Set(normalized).size === normalized.length &&
    normalized.every((item) => expected.includes(item))
}
function receiptLogs(receipt: TransactionReceipt): string {
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 1024) throw new Error('Collection receipt log count exceeds its bound.')
  let bytes = 0
  const indexes = new Set<number>()
  return JSON.stringify(receipt.logs.map((log) => {
    if (!isHexString(log.data) || log.data.length > 524_290 || !Array.isArray(log.topics) || log.topics.length > 8 ||
      log.topics.some((topic: unknown) => !isHexString(topic, 32)) || !Number.isSafeInteger(log.index) || log.index < 0 || indexes.has(log.index) ||
      log.transactionHash !== receipt.hash || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber || log.removed)
      throw new Error('Collection receipt has invalid or noncanonical logs.')
    indexes.add(log.index); bytes += log.data.length + log.topics.length * 66
    if (bytes > 8 * 1024 * 1024) throw new Error('Collection receipt exceeds its size limit.')
    return [getAddress(log.address), log.topics, log.data, log.index, log.transactionHash, log.blockHash, log.blockNumber]
  }))
}

/** Owner operations must not advance the live broadcaster's EOA nonce, including through type-4 authorizations. */
export async function assertExternalOwnerTransaction(provider: JsonRpcProvider, receipt: TransactionReceipt, operator: string) {
  const evidence = finalizedCreditEvidence(receipt), address = getAddress(operator)
  const tx = await bounded(provider.getTransaction(evidence.hash))
  if (!tx || tx.hash.toLowerCase() !== evidence.hash.toLowerCase() || tx.blockHash !== evidence.blockHash ||
    tx.blockNumber !== evidence.blockNumber || tx.chainId !== CHAIN || !tx.to || getAddress(tx.from) === address ||
    getAddress(receipt.from) !== getAddress(tx.from) || !receipt.to || getAddress(receipt.to) !== getAddress(tx.to))
    throw new Error('Owner operation is not bound to the external canonical sender.')
  const authorizations = tx.authorizationList ?? []
  if (authorizations.length > 8 || (tx.type === 4 && !authorizations.length) || authorizations.some((authorization) =>
    getAddress(verifyAuthorization(authorization, authorization.signature)) === address))
    throw new Error('Owner operation must not consume or authorize the gas operator nonce.')
  return tx
}

/** Read-only verification. Unsupported/truncated traces never release a collection hold. */
export async function verifyAnonNativeCollection(provider: JsonRpcProvider, receipt: TransactionReceipt, expected: {
  operator: string; token: string; nullifiers: readonly string[]; maximumInputs: number; maximumOutputs: number; maximumProofs: number; minimumNative: bigint
}): Promise<VerifiedNativeCollection> {
  const operator = getAddress(expected.operator), token = getAddress(expected.token)
  const wanted = expected.nullifiers.map((value) => value.toLowerCase())
  if (![1, 56].includes(CHAIN_ID) || operator === ZeroAddress || operator === ANON_COLLECTION_GATEWAY ||
    token !== getAddress(TOKENS[0].address) || !Number.isSafeInteger(expected.maximumInputs) || expected.maximumInputs < 1 || expected.maximumInputs > 2 ||
    !Number.isSafeInteger(expected.maximumOutputs) || expected.maximumOutputs < 1 || expected.maximumOutputs > 4 ||
    !Number.isSafeInteger(expected.maximumProofs) || expected.maximumProofs < 1 || expected.maximumProofs > 2 ||
    !wanted.length || wanted.length > expected.maximumInputs || new Set(wanted).size !== wanted.length ||
    wanted.some((value) => !isHexString(value, 32) || /^0x0{64}$/.test(value)) ||
    typeof expected.minimumNative !== 'bigint' || expected.minimumNative <= 0n || expected.minimumNative >= 2n ** 256n)
    throw new Error('Invalid ANON native collection scope or measured proof bounds.')
  const prior = finalizedCreditEvidence(receipt)
  const canonical = await bounded(finalizedCreditReceipt(provider, prior.hash))
  const first = finalizedCreditEvidence(canonical)
  const logsSnapshot = receiptLogs(canonical)
  if (first.status !== 1 || first.blockHash !== prior.blockHash || first.blockNumber !== prior.blockNumber ||
    logsSnapshot !== receiptLogs(receipt)) throw new Error('Collection receipt changed or did not succeed.')
  const feeData = ANON_COLLECTION_ABI.encodeFunctionData('baseFeeBP')
  const [tx, historicCode, currentCode, historicHelper, currentHelper, historicFee, currentFee] = await bounded(Promise.all([
    assertExternalOwnerTransaction(provider, canonical, operator), provider.getCode(ANON_COLLECTION_GATEWAY, first.blockNumber), provider.getCode(ANON_COLLECTION_GATEWAY),
    provider.getCode(ANON_COLLECTION_HELPER, first.blockNumber), provider.getCode(ANON_COLLECTION_HELPER),
    provider.call({ to: ANON_COLLECTION_GATEWAY, data: feeData, blockTag: first.blockNumber }),
    provider.call({ to: ANON_COLLECTION_GATEWAY, data: feeData }),
  ]))
  pinnedCode(historicCode); pinnedCode(currentCode)
  pinnedCode(historicHelper, true); pinnedCode(currentHelper, true)
  if ([historicFee, currentFee].some((value) => !isHexString(value, 32) ||
    ANON_COLLECTION_ABI.decodeFunctionResult('baseFeeBP', value)[0] !== ANON_COLLECTION_BASE_FEE_BPS))
    throw new Error('ANON collection gateway base fee differs from its approved 13 bps policy.')
  if (tx.value !== 0n ||
    !isHexString(tx.data) || tx.data.length > 524_290) throw new Error('Collection transaction is not bound to the external canonical sender.')
  const { root, frames } = parseTrace(await bounded(provider.send('debug_traceTransaction', [first.hash,
    { tracer: 'callTracer', timeout: '10s', tracerConfig: { onlyTopCall: false, withLog: false } }])) )
  if (root.type !== 'CALL' || root.failed || root.from !== getAddress(tx.from) || root.to !== getAddress(tx.to!) ||
    root.input !== tx.data.toLowerCase() || root.value !== tx.value) throw new Error('Collection trace is not bound to its canonical transaction.')
  const gateways = frames.filter((frame) => frame.type === 'CALL' && frame.to === ANON_COLLECTION_GATEWAY &&
    frame.input.startsWith(ANON_COLLECTION_ABI.getFunction('unshield')!.selector))
  if (gateways.length !== 1 || gateways[0].failed || gateways[0].value !== 0n)
    throw new Error('One successful canonical ANON gateway unshield is required.')
  const gateway = gateways[0], call = ANON_COLLECTION_ABI.parseTransaction({ data: gateway.input })
  const helpers = frames.filter((frame) => frame.from === ANON_COLLECTION_GATEWAY && ['DELEGATECALL', 'CALLCODE'].includes(frame.type))
  if (helpers.length !== 1 || helpers[0].parent !== gateway || helpers[0].type !== 'DELEGATECALL' || helpers[0].failed ||
    helpers[0].to !== ANON_COLLECTION_HELPER || helpers[0].value !== 0n || helpers[0].input !== HELPER_SELECTOR + gateway.input.slice(10))
    throw new Error('Collection gateway delegated outside its exact pinned helper and calldata.')
  const helper = helpers[0]
  if (!call || ANON_COLLECTION_ABI.encodeFunctionData(call.fragment, call.args).toLowerCase() !== gateway.input)
    throw new Error('Noncanonical ANON collection calldata.')
  const data = call.args._data, transactions = call.args._transactions
  if (getAddress(data.recipient) !== operator || data.integratorFeeBP !== 0n || getAddress(data.integratorFeeRecipient) !== ZeroAddress ||
    data.unwrapNative !== true || data.unwrapERC1155 !== false || data.erc1155RecipientData !== '0x' ||
    !transactions.length || transactions.length > expected.maximumProofs)
    throw new Error('ANON collection calldata does not bind the exact native recipient.')
  const nullifiers: string[] = [], unshields: { gross: bigint }[] = []
  let outputs = 0
  const tree = transactions[0].boundParams.treeNumber
  for (const transaction of transactions) {
    const bound = transaction.boundParams, unshield = transaction.unshieldPreimage
    outputs += transaction.commitments.length
    if (bound.chainID !== CHAIN || getAddress(bound.adaptContract) !== ANON_COLLECTION_GATEWAY || bound.treeNumber !== tree ||
      !transaction.nullifiers.length || !transaction.commitments.length || (bound.unshield !== 0n && bound.unshield !== 1n))
      throw new Error('ANON collection proof is outside its measured single-tree shape.')
    nullifiers.push(...transaction.nullifiers)
    if (bound.unshield === 1n) {
      if (getAddress(unshield.token.tokenAddress) !== token || unshield.token.tokenType !== 0n || unshield.token.tokenSubID !== 0n ||
        BigInt(unshield.npk) !== BigInt(ANON_COLLECTION_GATEWAY) || unshield.value <= 0n)
        throw new Error('Collection proof does not unshield the exact wrapped native token to its gateway.')
      unshields.push({ gross: unshield.value })
    }
  }
  if (!sameSet(nullifiers, wanted) || unshields.length !== 1 || outputs > expected.maximumOutputs)
    throw new Error('Collection proof inputs or outputs exceed the accounted shape.')
  const poolCalls = frames.filter((frame) => frame.parent === helper && frame.type === 'CALL' && frame.to === getAddress(NETWORK.proxyContract) &&
    frame.input === PROXY.encodeFunctionData('transact', [transactions]).toLowerCase())
  if (poolCalls.length !== 1 || poolCalls[0].failed || poolCalls[0].from !== ANON_COLLECTION_GATEWAY || poolCalls[0].value !== 0n)
    throw new Error('Collection trace did not execute the exact owned private inputs.')
  const loggedNullifiers: string[] = [], loggedUnshields: { amount: bigint; gross: bigint }[] = []
  for (const log of canonical.logs) {
    if (getAddress(log.address) !== getAddress(NETWORK.proxyContract)) continue
    if (log.removed || log.transactionHash !== first.hash || log.blockHash !== first.blockHash || log.blockNumber !== first.blockNumber)
      throw new Error('Collection events are not canonical.')
    const event = PROXY.parseLog(log)
    if (event?.name === 'Nullified') {
      if (event.args.treeNumber !== tree) throw new Error('Collection event has an unexpected Merkle tree.')
      loggedNullifiers.push(...event.args.nullifier)
    } else if (event?.name === 'Unshield') {
      const asset = event.args.token
      if (getAddress(event.args.to) !== ANON_COLLECTION_GATEWAY || getAddress(asset.tokenAddress) !== token ||
        asset.tokenType !== 0n || asset.tokenSubID !== 0n || event.args.amount <= 0n)
        throw new Error('Collection unshield event has the wrong asset or recipient.')
      loggedUnshields.push({ amount: event.args.amount, gross: event.args.amount + event.args.fee })
    }
  }
  if (!sameSet(loggedNullifiers, wanted) || loggedUnshields.length !== 1 || loggedUnshields[0].gross !== unshields[0].gross)
    throw new Error('Collection canonical events do not match its private proof.')
  const payments = frames.filter((frame) => frame.type === 'CALL' && frame.to === operator && frame.value > 0n)
  const nativeNet = loggedUnshields[0].amount - loggedUnshields[0].amount * ANON_COLLECTION_BASE_FEE_BPS / 10_000n
  if (payments.length !== 1 || payments[0].parent !== gateway || payments[0].from !== ANON_COLLECTION_GATEWAY || payments[0].failed ||
    payments[0].input !== '0x' || payments[0].value !== nativeNet || payments[0].value < expected.minimumNative ||
    frames.some((frame) => ['CALL', 'CREATE', 'CREATE2'].includes(frame.type) && frame.from === operator && frame.value > 0n))
    throw new Error('The exact native collection did not reach and remain with the gas operator.')
  const lastReceipt = await bounded(finalizedCreditReceipt(provider, first.hash)), last = finalizedCreditEvidence(lastReceipt)
  if (last.blockHash !== first.blockHash || last.blockNumber !== first.blockNumber || last.status !== 1 ||
    receiptLogs(lastReceipt) !== logsSnapshot) throw new Error('Collection changed during canonical trace verification.')
  const proof = Object.freeze({ verifiedNativeCollection: true as const })
  proofs.set(proof, Object.freeze({ transactionHash: first.hash, blockHash: first.blockHash, blockNumber: first.blockNumber,
    grossUnshield: unshields[0].gross, nativeReceived: payments[0].value, recipient: operator, token, gateway: ANON_COLLECTION_GATEWAY }))
  return proof
}
