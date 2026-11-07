import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { concat, getAddress, getBytes, hexlify, Interface, keccak256, zeroPadValue,
  type ContractTransaction } from 'ethers'
import { GUARD_ARTIFACT } from './execution-guard-artifact'

export const EXECUTION_GUARD = new Interface(GUARD_ARTIFACT.abi)
const ethereumDelegate = NETWORK_CONFIG[NetworkName.Ethereum].relayAdapt7702Contract

export function executionGuardCode(operator: string, delegateCode: string, selectedDelegate = ethereumDelegate): string {
  if (delegateCode === '0x') throw new Error('Canonical execution delegate is unavailable.')
  const delegate = getAddress(selectedDelegate)
  const values = { operator: zeroPadValue(getAddress(operator), 32), delegate: zeroPadValue(delegate, 32),
    delegateCodeHash: keccak256(delegateCode), authorizationCodeHash: keccak256(concat(['0xef0100', delegate])) }
  const bytes = getBytes(GUARD_ARTIFACT.runtime)
  for (const key of Object.keys(values) as (keyof typeof values)[])
    for (const reference of GUARD_ARTIFACT.immutables[key]) bytes.set(getBytes(values[key]), reference.start)
  return hexlify(bytes)
}

export function assertExecutionGuardCode(operator: string, code: string, delegateCode: string, selectedDelegate = ethereumDelegate): void {
  if (keccak256(code) !== keccak256(executionGuardCode(operator, delegateCode, selectedDelegate)))
    throw new Error('Execution guard code or pinned operator/delegate differs from the reviewed artifact.')
}

export function guardedExecution(transaction: ContractTransaction, nonce: bigint, guard: string): ContractTransaction {
  if (transaction.type !== 4 || typeof transaction.to !== 'string' || typeof transaction.data !== 'string')
    throw new Error('Only a validated private type-4 execution can use the guard.')
  return { ...transaction, to: getAddress(guard),
    data: EXECUTION_GUARD.encodeFunctionData('execute', [transaction.to, transaction.data, nonce]) }
}

export function decodeGuardedExecution(data: string): { account: string; execution: string; nonce: bigint } {
  const decoded = EXECUTION_GUARD.parseTransaction({ data })
  if (decoded?.name !== 'execute' || EXECUTION_GUARD.encodeFunctionData(decoded.fragment, decoded.args) !== data.toLowerCase())
    throw new Error('Canonical guarded execution calldata is required.')
  const execution = String(decoded.args.execution)
  if (!execution.startsWith('0x3e12cc2e')) throw new Error('Nonce-aware private execute calldata is required.')
  return { account: getAddress(decoded.args.account), execution, nonce: BigInt(decoded.args.expectedNonce) }
}
