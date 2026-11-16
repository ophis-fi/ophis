import { expect, it } from 'vitest'
import { calculateMaximumGas, EVMGasType } from '@railgun-community/shared-models'
import { bufferedArbitrumGasPrice, prepaidAttemptFee } from './prepaid-pricing'
import type { PreparedCredit } from './prepaid'

it.each([
  [20_046_000n, 20_046_000n, 100_000_000n, 22_050_601n],
  [20_000_001n, 10n, 100_000_000n, 22_000_003n],
  [20_000_000n, 25_000_000n, 100_000_000n, 25_000_000n],
  [95_000_000n, 95_000_000n, 100_000_000n, 100_000_000n],
])('buffers the reviewed COMMON price while retaining its floor and ceiling (%s)', (current, minimum, maximum, expected) => {
  expect(bufferedArbitrumGasPrice(current, minimum, maximum)).toBe(expected)
})

it.each([[100n, 101n, 100n], [100n, 100n, 100n], [0n, 0n, 100n], [1n, -1n, 100n], [1n, 1n, 0n]])(
  'refuses invalid or unaffordable COMMON floors (%s)', (current, minimum, maximum) => {
    expect(() => bufferedArbitrumGasPrice(current, minimum, maximum)).toThrow('reviewed prepaid limit')
  })

it('reserves Base total network cost instead of dropping data and operator fees from client consent', () => {
  const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }
  const credit = { scope: { chainId: 8453, funding: 'native' }, maximumGasCost: 20_000_000n,
    collectionAllowance: 0n, rate: 1_150_000_000_000_000_000n } as PreparedCredit
  expect(calculateMaximumGas(gas)).toBeLessThan(credit.maximumGasCost)
  expect(prepaidAttemptFee(credit, gas)).toBe(23_000_000n)
  expect(prepaidAttemptFee(credit, { ...gas, gasEstimate: 1n })).toBe(23_000_000n)
})

it.each([1, 56, 42161])('preserves execution-gas pricing on chain %i', chainId => {
  const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }
  const credit = { scope: { chainId, funding: 'native' }, maximumGasCost: 20_000_000n,
    collectionAllowance: 0n, rate: 1_150_000_000_000_000_000n } as PreparedCredit
  expect(prepaidAttemptFee(credit, gas)).toBe((calculateMaximumGas(gas) * 115n + 99n) / 100n)
})
