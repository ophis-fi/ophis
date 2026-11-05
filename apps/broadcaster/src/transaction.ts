import { ABIRailgunSmartWallet, ABIRelayAdapt7702, RelayAdapt7702ExecutionType,
  RelayAdapt7702Validator, type TransactionStructV2 } from '@railgun-community/engine'
import { versionCompare } from '@railgun-community/shared-models'
import { authorizationify, getAddress, Interface, isHexString, Signature, ZeroAddress, ZeroHash,
  type Authorization, type ContractTransaction } from 'ethers'
import { BROADCASTER_VERSION, CHAIN, CHAIN_ID, COMMON_TRANSACTION_TYPE, MAX_GAS, NETWORK, TOKENS, VERSION, type Settings } from './config'
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
  withdrawal?: { recipient: string; token: string; amount: bigint; grossAmount: bigint }
}

function boundStableWithdrawal(transactions: TransactionStructV2[], call: { to: unknown; data: unknown; value: unknown }, account: string): NonNullable<ParsedRequest['withdrawal']> {
  if (transactions.length !== 2 || BigInt(transactions[0].boundParams.unshield) !== 0n ||
    BigInt(transactions[1].boundParams.unshield) !== 1n || typeof call.to !== 'string' || getAddress(call.to) !== account ||
    typeof call.data !== 'string' || BigInt(String(call.value)) !== 0n)
    throw new Error('A bound stablecoin withdrawal requires one canonical self transfer and its private WBNB fee.')
  const transfer = ADAPT.parseTransaction({ data: call.data })
  if (transfer?.name !== 'transfer' || ADAPT.encodeFunctionData(transfer.fragment, transfer.args) !== call.data || transfer.args[0].length !== 1)
    throw new Error('A bound stablecoin withdrawal requires one canonical self transfer.')
  const output = transfer.args[0][0], principal = transactions[1].unshieldPreimage
  if (typeof output.token.tokenAddress !== 'string' || typeof output.to !== 'string' ||
    typeof principal.token.tokenAddress !== 'string' || typeof principal.npk !== 'string')
    throw new Error('Invalid bound withdrawal token or recipient.')
  const token = getAddress(output.token.tokenAddress), recipient = getAddress(output.to)
  const amount = BigInt(output.value), grossAmount = BigInt(principal.value)
  if (!TOKENS.slice(1).some((item) => item.address === token) || getAddress(principal.token.tokenAddress) !== token ||
    BigInt(principal.token.tokenType) !== 0n || BigInt(principal.token.tokenSubID) !== 0n ||
    BigInt(output.token.tokenType) !== 0n || BigInt(output.token.tokenSubID) !== 0n ||
    BigInt(principal.npk) !== BigInt(account) || recipient === account || amount <= 0n || amount > grossAmount ||
    transactions.some((tx) => !tx.nullifiers.length || !tx.commitments.length ||
      tx.boundParams.commitmentCiphertext.length !== tx.commitments.length - Number(tx.boundParams.unshield)))
    throw new Error('Invalid bound stablecoin withdrawal proof or transfer.')
  return { recipient, token, amount, grossAmount }
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
  let withdrawal: ParsedRequest['withdrawal']
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
    const action = decoded.args._actionData
    if (action.calls.length > 64 || (action.requireSuccess !== false && action.requireSuccess !== true))
      throw new Error('Unsupported private execution policy.')
    if (CHAIN_ID === 56 && transactions.some((tx) => BigInt(tx.boundParams.chainID) !== CHAIN ||
      typeof tx.boundParams.adaptContract !== 'string' || getAddress(tx.boundParams.adaptContract) !== to || tx.boundParams.adaptParams !== ZeroHash))
      throw new Error('Every BNB private proof must be bound to its signed execution account.')
    if (CHAIN_ID === 56 && !action.requireSuccess && action.calls.length === 1 &&
      action.calls[0].to === to && typeof action.calls[0].data === 'string' && action.calls[0].data.startsWith(ADAPT.getFunction('transfer')!.selector))
      throw new Error('A BNB public withdrawal must require its signed transfer to succeed.')
    RelayAdapt7702Validator.validateExecution(transactions, decoded.args._actionData, decoded.args._signature, CHAIN_ID, to,
      { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce })
    if (action.requireSuccess) {
      if (CHAIN_ID !== 56 || !settings.executionGuard || action.calls.length !== 1)
        throw new Error('Only guarded BNB stablecoin withdrawals may require all actions to succeed.')
      withdrawal = boundStableWithdrawal(transactions, action.calls[0], to)
    }
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
    if (CHAIN_ID === 56) {
      const withdrawal = transactions[transactions.length - 1]
      const tokenAddress = withdrawal?.unshieldPreimage.token.tokenAddress
      const token = typeof tokenAddress === 'string' ? getAddress(tokenAddress) : undefined
      if (transactions.length !== 1 || !withdrawal || token !== TOKENS[0].address || BigInt(withdrawal.boundParams.unshield) !== 1n ||
        BigInt(withdrawal.unshieldPreimage.token.tokenType) !== 0n || BigInt(withdrawal.unshieldPreimage.token.tokenSubID) !== 0n ||
        BigInt(withdrawal.unshieldPreimage.value) <= 0n ||
        transactions.some((tx) => !tx.nullifiers.length || !tx.commitments.length ||
          tx.boundParams.commitmentCiphertext.length !== tx.commitments.length - Number(tx.boundParams.unshield) ||
          BigInt(tx.boundParams.chainID) !== CHAIN || typeof tx.boundParams.adaptContract !== 'string' || getAddress(tx.boundParams.adaptContract) !== ZeroAddress ||
          tx.boundParams.adaptParams !== ZeroHash))
        throw new Error('BNB COMMON withdrawals require one WBNB proof; stablecoin withdrawals require signed bound execution.')
    } else if (transactions.length !== 1 || BigInt(transactions[0].boundParams.unshield) !== 1n)
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
    pois: data.preTransactionPOIsPerTxidLeafPerList, feesID: data.feesID, withdrawal }
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
