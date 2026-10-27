import { expect, it, vi } from 'vitest'
import { unusedSwapAccount } from './account'
import type { WalletSession } from './wallet'

it('skips used accounts after a restore even beyond the SDK history scan limit', async () => {
  const scan = vi.fn()
  const next = vi.fn(async () => ({ address: 'unused-101' }))
  const session = {
    accounts: {
      scanHistoryForEphemeralIndex: scan,
      getCurrentAccount: async () => ({ address: 'used-100' }),
      getNextAccount: next,
    },
    provider: { getTransactionCount: async (address: string) => (address === 'used-100' ? 1 : 0) },
  } as unknown as WalletSession
  expect((await unusedSwapAccount(session)).address).toBe('unused-101')
  expect(scan).toHaveBeenCalledOnce()
  expect(next).toHaveBeenCalledOnce()
})

it('bounds work when no unused account is found', async () => {
  const next = vi.fn(async () => ({ address: 'used' }))
  const session = {
    accounts: { scanHistoryForEphemeralIndex: async () => {}, getCurrentAccount: next, getNextAccount: next },
    provider: { getTransactionCount: async () => 1 },
  } as unknown as WalletSession
  await expect(unusedSwapAccount(session)).rejects.toThrow(/continue recovery safely/)
  expect(next).toHaveBeenCalledTimes(1001)
})
