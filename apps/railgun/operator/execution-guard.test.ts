import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { assertExecutionGuardCode, decodeGuardedExecution, EXECUTION_GUARD, executionGuardCode, guardedExecution } from './execution-guard'

describe('operator-bound execution guard', () => {
  it('preserves the signed private execution inside a canonical guard call', () => {
    const account = Wallet.createRandom().address, guard = Wallet.createRandom().address
    const original = { to: account, data: '0x3e12cc2e12345678', type: 4, value: 0n, chainId: 1n }
    const wrapped = guardedExecution(original, 123n, guard)
    expect(wrapped.to).toBe(guard)
    expect(decodeGuardedExecution(wrapped.data!)).toEqual({ account, execution: original.data, nonce: 123n })
    expect(wrapped.value).toBe(0n)
    expect(wrapped.chainId).toBe(1n)
    expect(original.to).toBe(account)
  })
  it('rejects changed code and code pinned to another operator or delegate implementation', () => {
    const operator = Wallet.createRandom().address
    const code = executionGuardCode(operator, '0x6001')
    expect(() => assertExecutionGuardCode(operator, code, '0x6001')).not.toThrow()
    expect(() => assertExecutionGuardCode(Wallet.createRandom().address, code, '0x6001')).toThrow('reviewed artifact')
    expect(() => assertExecutionGuardCode(operator, code, '0x6002')).toThrow('reviewed artifact')
    expect(() => assertExecutionGuardCode(operator, code.slice(0, -2) + 'ff', '0x6001')).toThrow('reviewed artifact')
    expect(() => executionGuardCode(operator, '0x')).toThrow('unavailable')
  })
  it('refuses alternate selectors, trailing ABI bytes and unvalidated transaction types', () => {
    const account = Wallet.createRandom().address
    const data = EXECUTION_GUARD.encodeFunctionData('execute', [account, '0x12345678', 0n])
    expect(() => decodeGuardedExecution(data)).toThrow('Nonce-aware')
    const canonical = EXECUTION_GUARD.encodeFunctionData('execute', [account, '0x3e12cc2e', 0n])
    expect(() => decodeGuardedExecution(canonical + '00')).toThrow('Canonical')
    expect(() => guardedExecution({ to: account, data: '0x3e12cc2e', type: 2 }, 0n, account)).toThrow('type-4')
  })
})
