import { expect, it, vi } from 'vitest'
import { validateRailgunAddress } from '@railgun-community/wallet'
import { CONFIG, FEE_SIGNER, PROTECTED_BROADCASTERS, TOKENS } from './config'
import { assertSubmittable } from './broadcaster'
import { EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import type { WalletSession } from './wallet'

vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(), ENVIRONMENT: 'ethereum' }))

it('binds Ethereum discovery and protection to the reviewed Ophis fee identity with an explicit review expiry', () => {
  expect(validateRailgunAddress(FEE_SIGNER)).toBe(true)
  expect(Object.keys(PROTECTED_BROADCASTERS)).toEqual(['1'])
  expect(PROTECTED_BROADCASTERS[1]).toEqual([
    { railgunAddress: FEE_SIGNER, expiresAt: Date.parse('2026-12-03T00:00:00Z'),
      maxGasPrice: 500_000_000n, maxTransactionCost: 1_500_000_000_000_000n },
  ])
})

it.each(['price', 'budget', 'valid'])('checks the reviewed %s limit before a proof or submission', async (condition) => {
  const read = vi.fn(async () => undefined)
  const session = { provider: { send: read, getNetwork: async () => ({ chainId: 1n }),
    getBlock: async () => ({ baseFeePerGas: 100_000_000n }) } } as unknown as WalletSession
  const selected = { railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
    tokenFee: { feePerUnitGas: '1150000000000000000', expiration: Date.now() + 600_000,
      relayAdapt7702: CONFIG.relayAdapt7702Contract } } as SelectedBroadcaster
  const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: condition === 'price' ? 100_000n : condition === 'budget' ? 4_000_000n : 3_000_000n,
    maxFeePerGas: condition === 'price' ? 600_000_000n : 400_000_000n, maxPriorityFeePerGas: 1n }
  if (condition === 'valid') await expect(assertSubmittable(session, selected, gas)).resolves.toBeUndefined()
  else {
    await expect(assertSubmittable(session, selected, gas)).rejects.toThrow(/exceeds the Ophis broadcaster limits/)
    expect(read).not.toHaveBeenCalled()
  }
  if (condition !== 'valid') await expect(assertSubmittable(session, selected, {
    evmGasType: EVMGasType.Type1, gasEstimate: gas.gasEstimate, gasPrice: gas.maxFeePerGas,
  })).rejects.toThrow(/exceeds the Ophis broadcaster limits/)
})
