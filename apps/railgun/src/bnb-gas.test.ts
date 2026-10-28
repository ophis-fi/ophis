import { afterEach, expect, it, vi } from 'vitest'
import type { SelectedBroadcaster } from '@railgun-community/shared-models'
import type { WalletSession } from './wallet'

afterEach(() => vi.unstubAllGlobals())

it('uses BNB legacy pricing in a valid type-4 envelope and refreshes its minimum price', async () => {
  vi.resetModules()
  vi.stubGlobal('location', new URL('http://localhost/?chainId=56'))
  const { gasDetails, minimumGasPrice, capGasPrice } = await import('./broadcaster')
  let price = 50n
  const session = { provider: { getFeeData: async () => ({ maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: price }) } } as unknown as WalletSession
  const gas = await gasDetails(session)
  expect(gas.maxFeePerGas).toBe(50n)
  expect(gas.maxPriorityFeePerGas).toBe(50n)
  price = 75n
  expect(await minimumGasPrice(session, gas)).toBe(75n)
  const selected = { tokenFee: { feePerUnitGas: '1000000000000000000' } } as SelectedBroadcaster
  const capped = capGasPrice(gas, selected, 5_000_000n)
  expect(capped.maxFeePerGas).toBeLessThan(gas.maxFeePerGas)
  expect(capped.maxPriorityFeePerGas).toBeLessThanOrEqual(capped.maxFeePerGas)
  price = 0n
  await expect(gasDetails(session)).rejects.toThrow(/unavailable/)
  await expect(minimumGasPrice(session, gas)).rejects.toThrow(/unavailable/)
})

it('does not use BNB pricing as an Ethereum fallback', async () => {
  vi.resetModules()
  vi.stubGlobal('location', new URL('http://localhost/?chainId=1'))
  const { gasDetails } = await import('./broadcaster')
  const session = { provider: { getFeeData: async () => ({ maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: 50n }) } } as unknown as WalletSession
  await expect(gasDetails(session)).rejects.toThrow(/unavailable/)
})
