import { ABIRailgunSmartWallet, ABIRelayAdapt7702, RelayAdapt7702ExecutionType,
  RelayAdapt7702Validator, type TransactionStructV2 } from '@railgun-community/engine'
import { authorizationify, getAddress, Interface, Signature, toQuantity, ZeroAddress,
  type ContractTransaction, type JsonRpcProvider } from 'ethers'
import { CONFIG, CHAIN, CHAIN_ID, VERSION, tokenFor } from './config'
import { assertExecutionGuardCode, EXECUTION_GUARD, guardedExecution } from '../operator/execution-guard'
import type { PendingSwap } from './journal'
import type { PendingWithdrawal } from './withdrawal-journal'
import { assertAtomicWithdrawal } from './execution'

type Provider = Pick<JsonRpcProvider, 'getNetwork' | 'getBlock' | 'getCode' | 'getTransactionCount' | 'getRpcTransaction' | 'send'>
const ADAPT = new Interface(ABIRelayAdapt7702), PRIVACY = new Interface(ABIRailgunSmartWallet)
const MAX_GAS = 8_000_000n
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error()
  return BigInt(value)
}
export function bindSavedCommonWithdrawal(request: unknown, pending: PendingWithdrawal, operator: string, guard = ZeroAddress) {
  if (!object(request) || CHAIN_ID !== 42161 || request.chainType !== 0 || request.chainID !== CHAIN_ID ||
    request.txidVersion !== VERSION || request.transactType !== 'COMMON' || request.useRelayAdapt !== false ||
    request.predelegated !== undefined || request.authorization !== undefined || pending.chainId !== CHAIN_ID ||
    pending.feeMode !== 'prepaid' || pending.hash || pending.execution || pending.output ||
    !Number.isSafeInteger(pending.fromBlock) || pending.fromBlock < 0 ||
    typeof request.to !== 'string' || typeof request.data !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(request.data) ||
    request.data.length > 256 * 1024 || getAddress(request.to) !== getAddress(CONFIG.proxyContract) ||
    getAddress(pending.transaction.to) !== getAddress(request.to) || pending.transaction.value !== '0' ||
    request.data.toLowerCase() !== pending.transaction.data.toLowerCase()) throw new Error()
  const data = request.data.toLowerCase(), sender = getAddress(operator)
  assertAtomicWithdrawal(data)
  const [transactions] = PRIVACY.decodeFunctionData('transact', data), proof = transactions[0]
  const note = proof.unshieldPreimage, recipient = getAddress(pending.recipient)
  const keys = (values: string[]) => {
    if (!values.length || values.length > 128 || values.some(v => !/^0x[0-9a-f]{64}$/i.test(v))) throw new Error()
    const result = values.map(v => v.toLowerCase()).sort()
    if (new Set(result).size !== result.length) throw new Error()
    return JSON.stringify(result)
  }
  if (sender === ZeroAddress || sender === getAddress(CONFIG.proxyContract) || recipient === ZeroAddress ||
    BigInt(note.npk) !== BigInt(recipient) || getAddress(note.token.tokenAddress) !== getAddress(tokenFor(pending.token).address) ||
    note.token.tokenType !== 0n || note.token.tokenSubID !== 0n || note.value <= 0n ||
    uint(pending.minimum) === 0n || uint(pending.minimum) > note.value ||
    keys(Array.from(proof.nullifiers, String)) !== keys(pending.nullifiers)) throw new Error()
  let gasPrice = uint(request.minGasPrice)
  if (!gasPrice || gasPrice < uint(pending.minGasPrice)) throw new Error()
  if (proof.boundParams.minGasPrice > gasPrice) gasPrice = proof.boundParams.minGasPrice
  // Match COMMON admission, including its type-1 envelope and absent gas limit.
  const transaction: ContractTransaction = { chainId: CHAIN, type: 1, to: CONFIG.proxyContract, data, value: 0n, gasPrice }
  return { common: true, account: CONFIG.proxyContract, sender, guard, gasLimit: MAX_GAS, transaction, batch: data }
}
function binding(request: unknown, pending: PendingSwap | PendingWithdrawal, operator: string, guard: string) {
  if ('transaction' in pending) return bindSavedCommonWithdrawal(request, pending, operator, guard)
  if (!object(request) || CHAIN_ID !== 42161 || request.chainType !== 0 || request.chainID !== CHAIN_ID ||
    request.txidVersion !== VERSION || request.transactType !== 'TX7702' || request.useRelayAdapt !== true ||
    request.predelegated !== undefined || pending.chainId !== CHAIN_ID || pending.feeMode !== 'prepaid' || pending.hash ||
    !Number.isSafeInteger(pending.index) || pending.index < 0 || !Number.isSafeInteger(pending.fromBlock) || pending.fromBlock < 0 ||
    typeof request.to !== 'string' || typeof request.data !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(request.data) ||
    request.data.length > 256 * 1024 || !object(request.authorization) || !object(request.authorization.signature)) throw new Error()
  const account = getAddress(pending.account), sender = getAddress(operator), destination = getAddress(guard)
  if (getAddress(request.to) !== account || new Set([account, sender, destination, ZeroAddress]).size !== 4) throw new Error()
  const auth = request.authorization, sig = auth.signature as Record<string, unknown>
  const authorization = authorizationify({ address: String(auth.address), chainId: uint(auth.chainId), nonce: uint(auth.nonce),
    signature: Signature.from({ r: String(sig.r), s: String(sig.s),
      ...(sig.yParity === 0 || sig.yParity === 1 ? { yParity: sig.yParity } : { v: Number(sig.v) }) }) })
  if (authorization.nonce >= 2n ** 64n - 1n) throw new Error()
  RelayAdapt7702Validator.validateAuthorization(authorization, CONFIG.relayAdapt7702Contract, CHAIN, account)
  const data = request.data.toLowerCase(), decoded = ADAPT.parseTransaction({ data }), nonce = uint(pending.executeNonce)
  if (decoded?.name !== 'execute' || ADAPT.encodeFunctionData(decoded.fragment, decoded.args) !== data || decoded.args._nonce !== nonce)
    throw new Error()
  const transactions = Array.from(decoded.args._transactions) as TransactionStructV2[], action = decoded.args._actionData
  if (!transactions.length || transactions.length > 8 || action.calls.length > 64 || action.requireSuccess !== false ||
    transactions.some(tx => BigInt(tx.boundParams.minGasPrice) !== 0n)) throw new Error()
  RelayAdapt7702Validator.validateExecution(transactions, action, decoded.args._signature, CHAIN, account,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: nonce })
  const inputs = transactions.flatMap(tx => tx.nullifiers.map(nullifier => ({ tree: Number(tx.boundParams.treeNumber), nullifier: String(nullifier) })))
  const keys = (values: typeof inputs) => {
    if (!values.length || values.length > 128 || values.some(v => !v || !Number.isInteger(v.tree) || v.tree < 0 || v.tree > 65535 ||
      typeof v.nullifier !== 'string' || !/^0x[0-9a-f]{64}$/i.test(v.nullifier))) throw new Error()
    const result = values.map(v => `${v.tree}:${v.nullifier.toLowerCase()}`).sort()
    if (new Set(result).size !== result.length) throw new Error()
    return JSON.stringify(result)
  }
  if (!Array.isArray(pending.inputs) || keys(inputs) !== keys(pending.inputs)) throw new Error()
  const gasLimit = uint(request.gasLimit), maxFeePerGas = uint(request.maxFeePerGas), maxPriorityFeePerGas = uint(request.maxPriorityFeePerGas)
  if (!gasLimit || gasLimit > MAX_GAS || !maxFeePerGas || !maxPriorityFeePerGas || maxPriorityFeePerGas > maxFeePerGas ||
    BigInt(action.minGasLimit) > gasLimit) throw new Error()
  const tx: ContractTransaction = { chainId: CHAIN, type: 4, to: account, data, value: 0n, authorizationList: [authorization],
    gasLimit, maxFeePerGas, maxPriorityFeePerGas }
  return { common: false, account, sender, guard: destination, gasLimit, transaction: guardedExecution(tx, nonce, destination),
    batch: PRIVACY.encodeFunctionData('transact', [transactions]) }
}
function rpcFailure(error: unknown) {
  const outer = object(error) ? error : {}, info = object(outer.info) ? outer.info : {}
  const inner = object(info.error) ? info.error : object(outer.error) ? outer.error : {}
  const rpcCode = [inner.code, outer.code].find(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= -(2 ** 31) && v < 2 ** 31)
  const text = [inner.message, outer.shortMessage, outer.message].filter(v => typeof v === 'string')
    .map(v => (v as string).slice(0, 512)).join(' ').toLowerCase()
  const category = rpcCode === -32602 ? 'invalid-params' : rpcCode === -32601 || rpcCode === -32004 ? 'method-unavailable'
    : outer.code === 'TIMEOUT' || /timeout|timed out|deadline exceeded/.test(text) ? 'timeout'
    : /max fee per gas less than block base fee|gas price.*less than.*base fee|fee cap less than block base fee/.test(text) ? 'fee-below-base'
    : /insufficient funds/.test(text) ? 'operator-funds'
    : /gas required exceeds allowance/.test(text) ? 'gas-allowance'
    : rpcCode === 3 || outer.code === 'CALL_EXCEPTION' || /execution reverted|execution failed|out of gas|intrinsic gas/.test(text)
      ? 'execution' : 'other'
  const data = [inner.data, outer.data].find(value => typeof value === 'string' &&
    value.length <= 4096 && /^0x(?:[0-9a-f]{2})+$/i.test(value))
  let rejection: string | undefined
  if (typeof data === 'string') try {
    const decoded = PRIVACY.parseError(data)
    const reasons: Record<string, string> = {
      'RailgunSmartWallet: Gas price too low': 'gas-price-floor',
      'RailgunSmartWallet: Invalid Adapt Contract as Sender': 'adapt-sender',
      'RailgunSmartWallet: ChainID mismatch': 'proof-chain',
      'RailgunSmartWallet: Invalid Merkle Root': 'merkle-root',
      'RailgunSmartWallet: Invalid Note Ciphertext Array Length': 'ciphertext-length',
      'RailgunSmartWallet: Invalid Withdraw Note': 'withdrawal-note',
      'RailgunSmartWallet: Invalid Snark Proof': 'snark-proof',
      'RailgunLogic: Note already spent': 'input-spent',
      'SafeERC20: low-level call failed': 'token-transfer',
      'ERC20: transfer amount exceeds balance': 'token-balance',
      'FiatToken: account is blacklisted': 'token-restriction',
    }
    if (decoded?.name === 'Error') rejection = Object.hasOwn(reasons, decoded.args[0]) ? reasons[decoded.args[0]] : 'unclassified-revert'
    else if (decoded?.name === 'Panic') rejection = 'evm-panic'
  } catch { /* Unknown provider data never leaves the diagnostic. */ }
  return { category, ...(rpcCode !== undefined && { rpcCode }), ...(rejection && { rejection }) }
}
function traceResult(trace: unknown, bound: ReturnType<typeof binding>) {
  let nodes = 0, found = false, failure: Record<string, unknown> | undefined, failedDepth = -1
  const visit = (node: unknown, path: number[]) => {
    if (++nodes > 4096 || path.length > 64) throw new Error('limit')
    if (!object(node) || typeof node.type !== 'string' || (node.calls !== undefined && !Array.isArray(node.calls))) throw new Error('malformed')
    const to = typeof node.to === 'string' ? node.to.toLowerCase() : ''
    if (node.type === 'CALL' && to === CONFIG.proxyContract.toLowerCase() && node.input === bound.batch) found = true
    if (node.error && path.length > failedDepth) {
      failedDepth = path.length
      const role = to === bound.guard.toLowerCase() ? 'guard' : to === bound.account.toLowerCase() ? 'account'
        : to === CONFIG.proxyContract.toLowerCase() ? 'privacy' : to === CONFIG.relayAdapt7702Contract.toLowerCase() ? 'delegate' : 'external'
      failure = { category: 'node-error', role, path: path.join('.') || 'root' }
      for (const field of ['gas', 'gasUsed']) if (typeof node[field] === 'string' && /^0x[0-9a-f]{1,64}$/i.test(node[field] as string))
        failure[field] = BigInt(node[field] as string).toString()
      if (typeof node.output === 'string' && /^0x[0-9a-f]{8}/i.test(node.output)) {
        const selector = node.output.slice(0, 10).toLowerCase()
        for (const abi of [EXECUTION_GUARD, ADAPT, PRIVACY]) {
          const known = abi.getError(selector)
          if (known) { failure.errorName = known.name; failure.selector = selector; break }
        }
      }
    }
    if (Array.isArray(node.calls)) node.calls.forEach((child, i) => visit(child, [...path, i]))
  }
  try { visit(trace, []); return failure ?? { category: found ? 'success' : 'exact-batch-absent' } }
  catch (error) { return { category: error instanceof Error && error.message === 'limit' ? 'limit' : 'malformed' } }
}

// Reconstructs a historical call, not the original server snapshot. No submission or journal mutation.
export async function diagnoseSavedTransaction(provider: Provider, request: unknown, pending: PendingSwap | PendingWithdrawal,
  operator: string, guard: string): Promise<string> {
  let stage = 'binding', closed = false, timer: ReturnType<typeof setTimeout> | undefined
  const invoke = async <T>(call: () => Promise<T>) => { if (closed) throw new Error(); return call() }
  const run = async () => {
    let anchor: { number: number; hash: string } | undefined, result: Record<string, unknown> = {}
    try {
      const bound = binding(request, pending, operator, guard)
      stage = 'network'
      if ((await invoke(() => provider.getNetwork())).chainId !== CHAIN) throw new Error()
      stage = 'historical-block'
      const block = await invoke(() => provider.getBlock(pending.fromBlock))
      if (!block || block.number !== pending.fromBlock || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error()
      anchor = { number: block.number, hash: block.hash }
      stage = 'historical-code'
      if (bound.common) {
        if (!/^0x(?:[0-9a-f]{2})+$/i.test(await invoke(() => provider.getCode(CONFIG.proxyContract, anchor!.number))) ||
          block.baseFeePerGas == null) throw new Error()
        if (BigInt(bound.transaction.gasPrice!) < block.baseFeePerGas + 1n) bound.transaction.gasPrice = block.baseFeePerGas + 1n
      } else {
        const delegate = await invoke(() => provider.getCode(CONFIG.relayAdapt7702Contract, anchor!.number))
        const guardCode = await invoke(() => provider.getCode(bound.guard, anchor!.number))
        assertExecutionGuardCode(bound.sender, guardCode, delegate, CONFIG.relayAdapt7702Contract)
      }
      if (await invoke(() => provider.getCode(bound.sender, anchor!.number)) !== '0x') throw new Error()
      stage = 'historical-nonce'
      const nonce = await invoke(() => provider.getTransactionCount(bound.sender, anchor!.number))
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error()
      const transaction = { ...bound.transaction, from: bound.sender, nonce }, tag = toQuantity(anchor.number)
      stage = 'historical-estimate'
      const estimate = await invoke(() => provider.send('eth_estimateGas', [provider.getRpcTransaction(transaction), tag]))
      if (typeof estimate !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(estimate) || !BigInt(estimate)) throw new Error()
      const gas = (BigInt(estimate) * 110n + 99n) / 100n
      result = { savedGas: bound.gasLimit.toString(), estimatedGas: BigInt(estimate).toString(), tracedGas: gas.toString() }
      if (gas > bound.gasLimit || gas > MAX_GAS) result.category = 'saved-gas-exceeded'
      else {
        stage = 'historical-trace'
        const trace = await invoke(() => provider.send('debug_traceCall', [provider.getRpcTransaction({ ...transaction, gasLimit: gas }), tag,
          { tracer: 'callTracer', timeout: '5s' }]))
        result = { ...result, ...traceResult(trace, bound) }
      }
    } catch (error) { result = { ...result, ...(stage === 'binding' ? { category: 'saved-binding-invalid' } : rpcFailure(error)) } }
    const completedStage = stage
    if (anchor && !closed) {
      stage = 'canonical-recheck'
      try {
        const current = await invoke(() => provider.getBlock(anchor!.number))
        if (!current || current.number !== anchor.number || current.hash !== anchor.hash) return JSON.stringify({ stage, category: 'reorg' })
      } catch (error) { return JSON.stringify({ stage, ...rpcFailure(error) }) }
    }
    return JSON.stringify({ stage: completedStage, ...result })
  }
  try {
    return await Promise.race([run(), new Promise<string>(resolve => { timer = setTimeout(() => {
      closed = true; resolve(JSON.stringify({ stage, category: 'timeout' }))
    }, 30_000) })])
  } finally { closed = true; if (timer) clearTimeout(timer) }
}
