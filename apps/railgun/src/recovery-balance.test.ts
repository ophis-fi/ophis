import { expect, it, vi } from 'vitest'
import type { WalletSession } from './wallet'

vi.mock('ethers', async original => ({ ...await original<typeof import('ethers')>(), Contract: class {
  constructor(private address: string) {}
  getFunction() { return async () => {
    if (this.address.toLowerCase().endsWith('1234')) throw new Error('Hostile token reverted')
    return 1n
  } }
} }))

it('keeps other recovery balances visible when an imported token reverts', async () => {
  const { registerToken } = await import('./config')
  const { scanRecovery } = await import('./recovery')
  const token = registerToken({ address: '0x0000000000000000000000000000000000001234', decimals: 18, symbol: 'CUSTOM' })
  const session = { accounts: { getAccount: async () => ({ address: '0x0000000000000000000000000000000000009876' }) },
    provider: { getBalance: async () => 0n } } as unknown as WalletSession
  const defaultScan = await scanRecovery(session, 0)
  expect(defaultScan).not.toContain('CUSTOM')
  expect(defaultScan).toContain('1 other listed tokens were not queried')
  const result = await scanRecovery(session, 0, [token])
  expect(result).toContain('USDC: 0.000001')
  expect(result).toContain('CUSTOM (0x0000000000000000000000000000000000001234): balance unavailable; do not assume zero.')
})
