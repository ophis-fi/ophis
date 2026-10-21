import {
  ABIRailgunSmartWallet,
  ABIRelayAdapt7702,
  ABIRelayAdapt7702_Legacy_PreExecuteNonce,
  RelayAdapt7702Helper,
  RelayAdapt7702ExecutionType,
  type RelayAdapt7702Request,
} from '@railgun-community/engine'
import { Contract, getAddress, Interface, verifyAuthorization, type TransactionRequest } from 'ethers'
import { CONFIG } from './config'
import type { WalletSession } from './wallet'

export const ADAPT = new Interface(ABIRelayAdapt7702)
export const PRIVACY = new Interface(ABIRailgunSmartWallet)
type Receipt = { status: number | null; logs: readonly { address: string; topics: readonly string[]; data: string }[] }
const REGISTRY = new Interface(['function getContractAddress(string name) view returns (address)'])

export function assertAuthorization(request: RelayAdapt7702Request): void {
  const authorization = request.authorization
  if (authorization.chainId !== 1n || getAddress(authorization.address) !== getAddress(CONFIG.relayAdapt7702Contract))
    throw new Error('Unexpected 7702 delegate or chain.')
  if (getAddress(verifyAuthorization(authorization, authorization.signature)) !== getAddress(request.ephemeralAddress))
    throw new Error('7702 authorization does not belong to the executing account.')
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
  if ((await session.provider.getNetwork()).chainId !== 1n) throw new Error('Ethereum RPC required.')
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
