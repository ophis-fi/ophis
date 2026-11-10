import { CHAIN, CHAIN_ID, CHAIN_NAME, CONFIG, tokenFor, type TokenSymbol } from './config'
import {
  ABIRailgunSmartWallet,
  ABIRelayAdapt7702,
  ABIRelayAdapt7702_Legacy_PreExecuteNonce,
  RelayAdapt7702Helper,
  RelayAdapt7702ExecutionType,
  RelayAdapt7702Validator,
  type TransactionStructV2,
  type RelayAdapt7702Request,
} from '@railgun-community/engine'
import { Contract, getAddress, Interface, verifyAuthorization, ZeroAddress, ZeroHash, type TransactionReceipt, type TransactionRequest } from 'ethers'
import type { WalletSession } from './wallet'
import type { PendingWithdrawal } from './withdrawal-journal'
import { assertExecutionGuardCode, decodeGuardedExecution } from '../operator/execution-guard'
import { feeTokenFor } from './fee-asset'

export const ADAPT = new Interface(ABIRelayAdapt7702)
export const PRIVACY = new Interface(ABIRailgunSmartWallet)
type Receipt = { status: number | null; logs: readonly { address: string; topics: readonly string[]; data: string }[] }
const REGISTRY = new Interface(['function getContractAddress(string name) view returns (address)'])
type WithdrawalTransaction = {
  nullifiers: readonly string[]
  commitments: readonly string[]
  boundParams: { unshield: bigint; minGasPrice: bigint; treeNumber: bigint; chainID: bigint; adaptContract: string; adaptParams: string; commitmentCiphertext: readonly unknown[] }
  unshieldPreimage: { npk: string; value: bigint; token: { tokenAddress: string; tokenType: bigint; tokenSubID: bigint } }
}

export function assertAtomicWithdrawal(data: string, feeToken?: TokenSymbol): void {
  const transactions = PRIVACY.decodeFunctionData('transact', data)[0] as readonly WithdrawalTransaction[]
  if (PRIVACY.encodeFunctionData('transact', [transactions]) !== data.toLowerCase()) throw new Error('Canonical withdrawal calldata is required.')
  if (transactions.length === 1 && transactions[0].boundParams.unshield === 1n) {
    if (feeToken && getAddress(transactions[0].unshieldPreimage.token.tokenAddress) !== getAddress(tokenFor(feeToken).address))
      throw new Error('An ERC20 withdrawal paid in another token requires a signed private execution.')
    return
  }
  throw new Error('This withdrawal cannot be safely broadcast. Its fee and output must share one proof; separate-token fees require a signed private execution.')
}

export function withdrawalOutput(data: string) {
  const transactions = PRIVACY.decodeFunctionData('transact', data)[0] as readonly WithdrawalTransaction[]
  const withdrawals = transactions.filter((transaction) => transaction.boundParams.unshield === 1n)
  if (withdrawals.length !== 1) throw new Error('Saved withdrawal output is ambiguous. Keep the complete saved proof.')
  return withdrawals[0].unshieldPreimage
}

export function assertBoundWithdrawal(data: string, account: string, token: TokenSymbol, recipient: string, minimum: bigint,
  output?: 'native', feeMode?: 'prepaid') {
  const decoded = ADAPT.parseTransaction({ data })
  const asset = tokenFor(token)
  const native = output === 'native'
  const prepaid = feeMode === 'prepaid'
  const sameFeeAsset = getAddress(asset.address) === getAddress(tokenFor(feeTokenFor(token)).address)
  if ((native ? CHAIN_ID !== 56 || !sameFeeAsset : sameFeeAsset && !prepaid) || decoded?.name !== 'execute' ||
    ADAPT.encodeFunctionData(decoded.fragment, decoded.args) !== data.toLowerCase()) throw new Error('Canonical signed withdrawal required.')
  const transactions = decoded.args._transactions as readonly WithdrawalTransaction[]
  const action = decoded.args._actionData
  const nullifiers = transactions.flatMap((tx) => [...tx.nullifiers])
  if (transactions.length !== (native || prepaid ? 1 : 2) || (!native && !prepaid && transactions[0].boundParams.unshield !== 0n) ||
    transactions[transactions.length - 1].boundParams.unshield !== 1n ||
    !action.requireSuccess || action.calls.length !== (native ? 2 : 1) || new Set(nullifiers).size !== nullifiers.length ||
    transactions.some((tx) => tx.boundParams.chainID !== CHAIN || tx.boundParams.minGasPrice !== 0n ||
      getAddress(tx.boundParams.adaptContract) !== getAddress(account) || tx.boundParams.adaptParams !== ZeroHash ||
      !tx.nullifiers.length || tx.nullifiers.includes(ZeroHash) || !tx.commitments.length)) throw new Error('Withdrawal proofs must be bound to the signed execution account.')
  if (action.calls.some((call: { to: string; value: bigint }) => getAddress(call.to) !== getAddress(account) || BigInt(call.value) !== 0n))
    throw new Error('Withdrawal calls must be zero-value self calls.')
  if (native) {
    const unwrap = action.calls[0]
    const [amount] = ADAPT.decodeFunctionData('unwrapBase', unwrap.data)
    if (minimum <= 0n || amount !== minimum || ADAPT.encodeFunctionData('unwrapBase', [amount]) !== unwrap.data.toLowerCase())
      throw new Error('Native withdrawal must unwrap the exact reviewed amount.')
  }
  const call = action.calls[action.calls.length - 1]
  const [transfers] = ADAPT.decodeFunctionData('transfer', call.data)
  const note = transactions[transactions.length - 1].unshieldPreimage
  if (transfers.length !== 1 ||
    ADAPT.encodeFunctionData('transfer', [transfers]) !== call.data.toLowerCase() ||
    getAddress(transfers[0].token.tokenAddress) !== (native ? ZeroAddress : getAddress(asset.address)) ||
    transfers[0].token.tokenType !== 0n || transfers[0].token.tokenSubID !== 0n ||
    getAddress(transfers[0].to) !== getAddress(recipient) || minimum <= 0n || transfers[0].value !== minimum ||
    getAddress(recipient) === ZeroAddress || getAddress(recipient) === getAddress(account) ||
    getAddress(note.token.tokenAddress) !== getAddress(asset.address) || note.token.tokenType !== 0n || note.token.tokenSubID !== 0n ||
    BigInt(note.npk) !== BigInt(account) || note.value <= 0n) throw new Error('Signed withdrawal transfer differs from the reviewed recipient or amount.')
  RelayAdapt7702Validator.validateExecution(transactions as unknown as TransactionStructV2[], action, decoded.args._signature, CHAIN_ID, account,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: BigInt(decoded.args._nonce) })
  return { transactions, executeNonce: BigInt(decoded.args._nonce) }
}

export function assertAuthorization(request: RelayAdapt7702Request): void {
  const authorization = request.authorization
  if (authorization.chainId !== CHAIN || getAddress(authorization.address) !== getAddress(CONFIG.relayAdapt7702Contract))
    throw new Error('Unexpected 7702 delegate or chain.')
  if (getAddress(verifyAuthorization(authorization, authorization.signature)) !== getAddress(request.ephemeralAddress))
    throw new Error('7702 authorization does not belong to the executing account.')
}

// Native output has no recipient Transfer event. In addition to the canonical
// unshield/unwrap logs, confirmation must bind the actual successful transaction
// to the complete signed native action and the trusted account/guard code.
export async function assertNativeExecutionBinding(session: WalletSession, receipt: TransactionReceipt, pending: PendingWithdrawal, hash: string): Promise<void> {
  const e = pending.execution
  if (pending.output !== 'native' || !e || (await session.provider.getNetwork()).chainId !== CHAIN)
    throw new Error('Native withdrawal requires its bound execution on the selected chain.')
  assertBoundWithdrawal(pending.transaction.data, e.account, pending.token, pending.recipient, BigInt(pending.minimum), 'native', pending.feeMode)
  const transaction = await session.provider.getTransaction(hash)
  if (!transaction?.to || transaction.hash.toLowerCase() !== hash.toLowerCase() || transaction.blockNumber !== receipt.blockNumber ||
    transaction.value !== 0n) throw new Error('Native receipt is not bound to the saved signed execution.')
  const account = getAddress(e.account)
  const delegateCode = await session.provider.getCode(CONFIG.relayAdapt7702Contract, receipt.blockNumber)
  if (delegateCode === '0x') throw new Error('Canonical native withdrawal delegate is unavailable.')
  if (getAddress(transaction.to) === account) {
    if (transaction.data.toLowerCase() !== pending.transaction.data.toLowerCase()) throw new Error('Native receipt calldata differs from the saved execution.')
  } else {
    const guarded = decodeGuardedExecution(transaction.data)
    if (guarded.account !== account || guarded.execution.toLowerCase() !== pending.transaction.data.toLowerCase() ||
      guarded.nonce !== BigInt(e.executeNonce)) throw new Error('Native guard receipt differs from the saved execution.')
    assertExecutionGuardCode(transaction.from, await session.provider.getCode(transaction.to, receipt.blockNumber), delegateCode, CONFIG.relayAdapt7702Contract)
  }
  if ((await session.provider.getCode(account, receipt.blockNumber)).toLowerCase() !== `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`)
    throw new Error('Native receipt account does not use the canonical delegate.')
  const nonce: bigint = await new Contract(account, ADAPT, session.provider).getFunction('nonce')({ blockTag: receipt.blockNumber })
  if (nonce <= BigInt(e.executeNonce)) throw new Error('Native execution nonce was not advanced.')
}

export function encodeRequest(request: RelayAdapt7702Request): TransactionRequest {
  assertAuthorization(request)
  const abi =
    request.executionType === RelayAdapt7702ExecutionType.LegacyPreExecuteNonce
      ? ABIRelayAdapt7702_Legacy_PreExecuteNonce
      : ABIRelayAdapt7702
  const data = RelayAdapt7702Helper.encodeExecute(
    new Interface(abi),
    request.transactions,
    request.actionData,
    request.executionSignature,
    request,
  )
  return { to: request.ephemeralAddress, data, value: 0n, type: 4, authorizationList: [request.authorization] }
}

export async function assertExecutionNetwork(session: WalletSession): Promise<void> {
  if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
  const registered = await new Contract(CONFIG.railgunRegistryContract, REGISTRY, session.provider).getFunction(
    'getContractAddress',
  )('RelayAdapt7702')
  if (getAddress(registered) !== getAddress(CONFIG.relayAdapt7702Contract))
    throw new Error('Railgun delegate registry changed. Review before continuing.')
}

export function assertSameExecution(
  session: WalletSession,
  request: RelayAdapt7702Request,
  transaction: TransactionRequest,
): void {
  const expected = session.provider.getRpcTransaction(encodeRequest(request))
  const actual = session.provider.getRpcTransaction(transaction)
  for (const field of ['to', 'data', 'authorizationList'] as const) {
    if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field]))
      throw new Error('Populated transaction differs from the signed execution. Submission blocked.')
  }
  if (BigInt(transaction.value || 0) !== 0n) throw new Error('Unexpected public value in a private swap.')
}

export async function simulateRequest(
  session: WalletSession,
  request: RelayAdapt7702Request,
  gasLimit: bigint,
): Promise<void> {
  assertAuthorization(request)
  await assertExecutionNetwork(session)
  const probe = encodeRequest(request)
  const delegated = await session.provider.call({
    ...probe,
    data: ADAPT.encodeFunctionData('adaptImplementation'),
    gasLimit,
  })
  if (!delegated || delegated === '0x') throw new Error('RPC did not execute the 7702 delegation. Submission blocked.')
  const implementation = ADAPT.decodeFunctionResult('adaptImplementation', delegated)[0]
  if (getAddress(implementation) !== getAddress(CONFIG.relayAdapt7702Contract))
    throw new Error('Unexpected delegated implementation.')
  // The dead address is the SDK's proof-verification bypass, suitable only for dummy estimates.
  const transaction = session.provider.getRpcTransaction({
    ...probe,
    gasLimit,
    from: '0x0000000000000000000000000000000000000001',
  })
  const trace: unknown = await session.provider.send('debug_traceCall', [
    transaction,
    'latest',
    { tracer: 'callTracer' },
  ])
  assertTraceSuccess(trace)
}

export function assertTraceSuccess(trace: unknown): void {
  if (!trace || typeof trace !== 'object' || !('type' in trace) || typeof trace.type !== 'string')
    throw new Error('RPC did not return a usable execution trace. Submission blocked.')
  if ('error' in trace && trace.error)
    throw new Error('A private transaction call would fail. Refresh the quote before submitting.')
  if ('calls' in trace) {
    if (!Array.isArray(trace.calls)) throw new Error('RPC returned a malformed call trace.')
    trace.calls.forEach(assertTraceSuccess)
  }
}

export function assertReceipt(receipt: Receipt, ephemeralAddress: string): void {
  if (receipt.status !== 1) throw new Error('Transaction reverted.')
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(ephemeralAddress)) continue
    const parsed = ADAPT.parseLog({ topics: [...log.topics], data: log.data })
    if (parsed?.name === 'CallError')
      throw new Error('A private transaction call failed. Open recovery to check public leftovers.')
  }
}

export function expectedOutputNpk(request: RelayAdapt7702Request, token: string): string {
  const call = request.actionData.calls.at(-1)
  if (!call || getAddress(String(call.to)) !== getAddress(request.ephemeralAddress))
    throw new Error('Missing final reshield call.')
  const [requests] = ADAPT.decodeFunctionData('shield', String(call.data))
  const matching = [...requests].find((shield) => getAddress(shield.preimage.token.tokenAddress) === getAddress(token))
  if (!matching) throw new Error('Output token is missing from reshielding.')
  return String(matching.preimage.npk)
}

export function assertPrivateOutput(receipt: Receipt, token: string, npk: string, minimum: bigint): void {
  const amount = receipt.logs.reduce((sum, log) => {
    if (getAddress(log.address) !== getAddress(CONFIG.proxyContract)) return sum
    const parsed = PRIVACY.parseLog({ topics: [...log.topics], data: log.data })
    if (parsed?.name !== 'Shield') return sum
    return (
      sum +
      [...parsed.args.commitments].reduce((total, note) => {
        return getAddress(note.token.tokenAddress) === getAddress(token) && String(note.npk) === npk
          ? total + BigInt(note.value)
          : total
      }, 0n)
    )
  }, 0n)
  if (minimum <= 0n || amount < minimum)
    throw new Error('Expected private output was not confirmed. Check recovery before retrying.')
}
