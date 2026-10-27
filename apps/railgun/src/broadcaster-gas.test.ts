import { expect, it, vi } from 'vitest'
import { EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import type { WalletSession } from './wallet'

vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(), ENVIRONMENT: 'ethereum' }))
import { assertSubmittable, broadcasterFee, capGasPrice, minimumGasPrice } from './broadcaster'
import { FEE_SIGNER, TOKENS } from './config'

const selected = {
  railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
  tokenFee: { feePerUnitGas: '1000000000000000000', expiration: Date.now() + 600_000, feesID: 'test' },
} as SelectedBroadcaster
const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: 3_098_193n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }

it('fits the fee budget without reducing gas units or the tip, and rounds the cap downward', () => {
  const budget = 716_490_555_332_357n
  const capped = capGasPrice(gas, selected, budget)
  expect(capped.gasEstimate).toBe(gas.gasEstimate)
  expect(capped.maxPriorityFeePerGas).toBe(gas.maxPriorityFeePerGas)
  expect(broadcasterFee(selected, capped).amount).toBeLessThanOrEqual(budget)
  expect(broadcasterFee(selected, { ...capped, maxFeePerGas: capped.maxFeePerGas + 1n }).amount).toBeGreaterThan(budget)
  expect(gas.maxFeePerGas).toBe(1_000_000_000n)
  expect(capGasPrice({ ...gas, maxFeePerGas: 1n }, selected, budget).maxFeePerGas).toBe(1n)
})

it('rejects invalid fee budgets and rates', () => {
  for (const budget of [0n, -1n]) expect(() => capGasPrice(gas, selected, budget)).toThrow('Invalid broadcaster fee budget')
  expect(() => capGasPrice(gas, { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '0' } }, 1n)).toThrow('Invalid broadcaster fee budget')
})

it('caps USDC fees in token base units using the same SDK formula', () => {
  const usdc = { ...selected, tokenAddress: TOKENS.USDC.address, tokenFee: { ...selected.tokenFee, feePerUnitGas: '2300000000' } }
  const capped = capGasPrice(gas, usdc, 1_000_000n)
  expect(capped.maxFeePerGas).toBeLessThan(gas.maxFeePerGas)
  expect(broadcasterFee(usdc, capped).amount).toBeLessThanOrEqual(1_000_000n)
  expect(broadcasterFee(usdc, capped).tokenAddress).toBe(TOKENS.USDC.address)
})

it('matches the SDK rounding boundary for fractional rates and very small or large budgets', () => {
  for (const rate of ['1000000000000000000', '805304349000000000', '2300000000']) {
    const broadcaster = { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: rate } }
    for (const budget of [1n, 1_000_000n, 716_490_555_332_357n, 10n ** 24n]) {
      for (const gasEstimate of [3_000_000n, 3_098_157n, 6_000_000n]) {
        const capped = capGasPrice({ ...gas, gasEstimate, maxFeePerGas: 10n ** 30n }, broadcaster, budget)
        expect(broadcasterFee(broadcaster, capped).amount).toBeLessThanOrEqual(budget)
        expect(broadcasterFee(broadcaster, { ...capped, maxFeePerGas: capped.maxFeePerGas + 1n }).amount).toBeGreaterThan(budget)
      }
    }
  }
})

it('checks the latest base fee plus the full quoted tip before private submission', async () => {
  const block = vi.fn().mockResolvedValue({ baseFeePerGas: 100n })
  const session = { provider: { send: async () => undefined, getNetwork: async () => ({ chainId: 1n }), getBlock: block } } as unknown as WalletSession
  const priced = { ...gas, maxFeePerGas: 101n }
  expect(await minimumGasPrice(session, priced)).toBe(101n)
  await expect(assertSubmittable(session, selected, priced)).resolves.toBeUndefined()
  block.mockResolvedValue({ baseFeePerGas: 101n })
  await expect(assertSubmittable(session, selected, priced)).rejects.toThrow('exceeds this quote’s cap')
  block.mockResolvedValue(null)
  await expect(assertSubmittable(session, selected, priced)).rejects.toThrow('base fee unavailable')
  block.mockClear()
  await expect(assertSubmittable(session, selected, { evmGasType: EVMGasType.Type1, gasEstimate: 3_000_000n, gasPrice: 1n })).resolves.toBeUndefined()
  expect(block).not.toHaveBeenCalled()
})
