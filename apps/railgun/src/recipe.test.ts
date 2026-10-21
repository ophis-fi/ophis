import { describe, expect, it } from 'vitest'
import { AbiCoder, getAddress, solidityPacked } from 'ethers'
import { amountFromInput, assertQuoteFresh, unshieldAmount, recipeCalls, type SwapQuote } from './recipe'
import { ERC20, OPHIS_FEE, PERMIT, PERMIT2, ROUTER, ROUTER_RECIPIENT, SWAP, TOKENS } from './config'

const account = '0x0000000000000000000000000000000000001234'

describe('private swap amounts and recipe', () => {
  it('uses exact integer units and rejects excess precision and nonpositive input', () => {
    expect(amountFromInput('1.000001', 'USDC')).toBe(1_000_001n)
    expect(amountFromInput('0.000000000000000001', 'WETH')).toBe(1n)
    for (const value of ['0', '-1', '1e6', 'NaN', '1.0000001']) expect(() => amountFromInput(value, 'USDC')).toThrow()
  })
  it('conserves the input after Railgun rounding and the Ophis fee', () => {
    for (const amount of [1n, 99n, 10_000n, 1_000_001n, 2n ** 80n]) {
      for (const fee of [0n, 1n, 25n, 9999n]) {
        const result = unshieldAmount(amount, fee)
        expect(result + (amount * fee) / 10_000n).toBe(amount)
        expect(result).toBeGreaterThan(0n)
      }
    }
    expect(() => unshieldAmount(1n, 10_000n)).toThrow()
  })
  it('pins approvals, recipient, minimum, deadline, fee and approval revocation', () => {
    const calls = recipeCalls('USDC', 'WETH', account, 997_500n, 321n, 123456)
    expect(calls).toHaveLength(5)
    expect(calls.every((call) => call.value === 0n)).toBe(true)
    expect(calls[0].to).toBe(TOKENS.USDC.address)
    expect(ERC20.decodeFunctionData('approve', calls[0].data)).toEqual([PERMIT2, 997_500n])
    expect(PERMIT.decodeFunctionData('approve', calls[1].data)).toEqual([
      TOKENS.USDC.address,
      getAddress(ROUTER),
      997_500n,
      123456n,
    ])
    expect(calls[2].to).toBe(ROUTER)
    const [commands, inputs, deadline] = SWAP.decodeFunctionData('execute', calls[2].data)
    expect(commands).toBe('0x00060404')
    expect(deadline).toBe(123456n)
    const abi = AbiCoder.defaultAbiCoder()
    expect([...abi.decode(['address', 'uint256', 'uint256', 'bytes', 'bool'], inputs[0])]).toEqual([
      ROUTER_RECIPIENT,
      997_500n,
      321n,
      solidityPacked(['address', 'uint24', 'address'], [TOKENS.USDC.address, 500, TOKENS.WETH.address]),
      true,
    ])
    expect([...abi.decode(['address', 'address', 'uint256'], inputs[1])]).toEqual([
      getAddress(TOKENS.WETH.address),
      OPHIS_FEE.recipient,
      1n,
    ])
    expect([...abi.decode(['address', 'address', 'uint256'], inputs[2])]).toEqual([
      getAddress(TOKENS.WETH.address),
      account,
      321n,
    ])
    expect(PERMIT.decodeFunctionData('approve', calls[3].data)[2]).toBe(0n)
    expect(ERC20.decodeFunctionData('approve', calls[4].data)).toEqual([PERMIT2, 0n])
  })
  it('refuses zero minimum output, stale quotes and changed temporary accounts', () => {
    expect(() => recipeCalls('USDC', 'WETH', account, 1n, 0n, 1)).toThrow()
    const quote = { account, deadline: Math.floor(Date.now() / 1000) + 120 } as SwapQuote
    expect(() => assertQuoteFresh(quote, account)).not.toThrow()
    expect(() => assertQuoteFresh(quote, ROUTER)).toThrow(/account changed/)
    expect(() => assertQuoteFresh({ ...quote, deadline: 1 }, account)).toThrow(/expired/)
  })
})
