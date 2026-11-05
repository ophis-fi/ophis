import { ABIRailgunSmartWallet, ABIRelayAdapt7702, RelayAdapt7702ExecutionType,
  RelayAdapt7702Validator, type TransactionStructV2 } from '@railgun-community/engine'
import { versionCompare } from '@railgun-community/shared-models'
import { authorizationify, getAddress, Interface, isHexString, Signature,
  type Authorization, type ContractTransaction } from 'ethers'
import { BROADCASTER_VERSION, CHAIN, CHAIN_ID, COMMON_TRANSACTION_TYPE, MAX_GAS, NETWORK, VERSION, type Settings } from './config'
import { object } from './wire'

export const ADAPT = new Interface(ABIRelayAdapt7702)
export const PROXY = new Interface(ABIRailgunSmartWallet)

export function uint(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Invalid unsigned quantity.')
  const parsed = BigInt(value)
  if (parsed >= 2n ** 256n || (positive && parsed === 0n)) throw new Error('Quantity exceeds its permitted range.')
  return parsed
}

export interface ParsedRequest {
  transaction: ContractTransaction
  type4: boolean
  authorization?: Authorization
  executeNonce?: bigint
  transactions: TransactionStructV2[]
  nullifiers: string[]
  pois: Record<string, unknown>
  feesID: string
}

export function parseRequest(data: Record<string, unknown>, operator: string, settings: Settings): ParsedRequest {
  if (settings.chainId !== CHAIN_ID || data.chainType !== 0 || data.chainID !== CHAIN_ID || data.txidVersion !== VERSION ||
    typeof data.minVersion !== 'string' || typeof data.maxVersion !== 'string' ||
    !/^8\.[0-9]{1,3}\.[0-9]{1,3}$/.test(data.minVersion) || !/^8\.[0-9]{1,3}\.[0-9]{1,3}$/.test(data.maxVersion) ||
    versionCompare(BROADCASTER_VERSION, data.minVersion) < 0 || versionCompare(BROADCASTER_VERSION, data.maxVersion) > 0 ||
    typeof data.to !== 'string' || typeof data.data !== 'string' || !isHexString(data.data) || data.data.length > 256 * 1024 ||
    typeof data.feesID !== 'string' || !/^[0-9a-f]{64}$/.test(data.feesID) || !object(data.preTransactionPOIsPerTxidLeafPerList))
    throw new Error('Unsupported or malformed private request.')
  const to = getAddress(data.to), calldata = data.data.toLowerCase()
  let transaction: ContractTransaction, transactions: TransactionStructV2[], authorization: Authorization | undefined
  let executeNonce: bigint | undefined
  const type4 = data.transactType === 'TX7702'
  if (type4) {
    if (!object(data.authorization) || !object(data.authorization.signature) || data.useRelayAdapt !== true || to === getAddress(operator))
      throw new Error('A canonical private execution authorization is required.')
    const auth = data.authorization
    const sig = data.authorization.signature
    authorization = authorizationify({ address: String(auth.address), chainId: uint(auth.chainId),
      nonce: uint(auth.nonce), signature: Signature.from({ r: String(sig.r), s: String(sig.s),
        ...(sig.yParity === 0 || sig.yParity === 1 ? { yParity: sig.yParity } : { v: Number(sig.v) }) }) })
    if (authorization.nonce >= 2n ** 64n - 1n) throw new Error('Invalid authorization nonce.')
    RelayAdapt7702Validator.validateAuthorization(authorization, NETWORK.relayAdapt7702Contract, CHAIN_ID, to)
    const decoded = ADAPT.parseTransaction({ data: calldata })
    if (decoded?.name !== 'execute' || ADAPT.encodeFunctionData(decoded.fragment, decoded.args) !== calldata)
      throw new Error('Canonical nonce-aware private execute calldata is required.')
    transactions = Array.from(decoded.args._transactions) as TransactionStructV2[]
    // EIP-1559 effective gas prices can fall after simulation; canonical 7702 SDK proofs use zero.
    if (transactions.some((tx) => BigInt(tx.boundParams.minGasPrice) !== 0n))
      throw new Error('Private type-4 proofs must use a zero gas-price floor.')
    executeNonce = BigInt(decoded.args._nonce)
    if (decoded.args._actionData.requireSuccess !== false || decoded.args._actionData.calls.length > 64)
      throw new Error('Unsupported private execution policy.')
    RelayAdapt7702Validator.validateExecution(transactions, decoded.args._actionData, decoded.args._signature, CHAIN_ID, to,
      { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce })
    const gasLimit = uint(data.gasLimit, true), maxFeePerGas = uint(data.maxFeePerGas, true)
    const maxPriorityFeePerGas = uint(data.maxPriorityFeePerGas, true)
    if (gasLimit > MAX_GAS || maxFeePerGas > settings.maxGasPrice || maxPriorityFeePerGas > maxFeePerGas ||
      gasLimit * maxFeePerGas > settings.maxTransactionCost || BigInt(decoded.args._actionData.minGasLimit) > gasLimit)
      throw new Error('The request exceeds the operator gas budget.')
    transaction = { to, data: calldata, value: 0n, type: 4, gasLimit, maxFeePerGas, maxPriorityFeePerGas,
      authorizationList: [authorization], chainId: CHAIN }
  } else {
    if (data.transactType !== 'COMMON' || data.useRelayAdapt !== false || to !== getAddress(NETWORK.proxyContract))
      throw new Error('Only canonical privacy-contract withdrawals are supported as common requests.')
    const decoded = PROXY.parseTransaction({ data: calldata })
    if (decoded?.name !== 'transact' || PROXY.encodeFunctionData(decoded.fragment, decoded.args) !== calldata)
      throw new Error('Canonical privacy transact calldata is required.')
    transactions = Array.from(decoded.args._transactions) as TransactionStructV2[]
    if (transactions.length !== 1 || BigInt(transactions[0].boundParams.unshield) !== 1n)
      throw new Error('The withdrawal and broadcaster fee must share one proof.')
    const gasPrice = uint(data.minGasPrice, true)
    if (gasPrice > settings.maxGasPrice) throw new Error('The request exceeds the operator gas-price limit.')
    transaction = { to, data: calldata, value: 0n, type: COMMON_TRANSACTION_TYPE, gasPrice, chainId: CHAIN }
  }
  const nullifiers = transactions.flatMap((tx) => Array.from(tx.nullifiers, String))
  if (!transactions.length || transactions.length > 8 || !nullifiers.length || nullifiers.length > 128 ||
    nullifiers.some((n) => !isHexString(n, 32)) || new Set(nullifiers).size !== nullifiers.length)
    throw new Error('Invalid private transaction or nullifier set.')
  return { transaction, transactions, type4, authorization, executeNonce, nullifiers,
    pois: data.preTransactionPOIsPerTxidLeafPerList, feesID: data.feesID }
}

export function assertTraceSuccess(trace: unknown, count = { nodes: 0 }, depth = 0): void {
  if (!object(trace) || typeof trace.type !== 'string' || trace.error || depth > 64 || ++count.nodes > 4096)
    throw new Error('Private transaction simulation failed.')
  if (trace.calls !== undefined) {
    if (!Array.isArray(trace.calls)) throw new Error('Malformed private execution trace.')
    for (const call of trace.calls) assertTraceSuccess(call, count, depth + 1)
  }
}

export function assertPrivateExecution(trace: unknown, transactCalldata: string): void {
  assertTraceSuccess(trace)
  const containsPayment = (call: Record<string, unknown>): boolean =>
    call.type === 'CALL' && typeof call.to === 'string' &&
      call.to.toLowerCase() === NETWORK.proxyContract.toLowerCase() &&
      call.input === transactCalldata ||
    Array.isArray(call.calls) && call.calls.some((child) => containsPayment(child as Record<string, unknown>))
  if (!containsPayment(trace as Record<string, unknown>))
    throw new Error('Simulation did not execute the exact fee-bearing private batch.')
}
