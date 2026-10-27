import { expect, it, vi } from 'vitest'
import { EVMGasType } from '@railgun-community/shared-models'
import { CONFIG, TOKENS } from './config'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ reconcile: vi.fn(), save: vi.fn() }))
vi.mock('./storage', () => ({}))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn() }))
vi.mock('./broadcaster', () => ({ broadcasterFee: vi.fn(), validateBroadcaster: vi.fn() }))
vi.mock('./withdrawal-journal', async (original) => ({
  ...(await original<typeof import('./withdrawal-journal')>()),
  pendingWithdrawal: async () => undefined,
  savePendingWithdrawal: state.save,
  reconcilePendingWithdrawal: state.reconcile,
}))
vi.mock('@railgun-community/wallet', () => ({
  generateUnshieldProof: async () => {},
  populateProvedUnshield: async () => ({
    transaction: { to: CONFIG.proxyContract, data: '0x1234' },
    nullifiers: [`0x${'11'.repeat(32)}`],
  }),
  gasEstimateForUnprovenUnshield: vi.fn(),
  getWalletTransactionHistory: vi.fn(),
}))
import { executeUnshield } from './unshield'

it('does not report a confirmed withdrawal when the expected output is missing but its input was spent', async () => {
  const hash = `0x${'22'.repeat(32)}`
  const session = {
    info: { id: 'test' },
    provider: { getBlockNumber: async () => 100, waitForTransaction: async () => ({ status: 1, logs: [] }) },
  } as unknown as WalletSession
  const prepared = {
    token: 'USDC',
    amounts: [
      {
        tokenAddress: TOKENS.USDC.address,
        amount: 1_000_000n,
        recipientAddress: '0x0000000000000000000000000000000000001234',
      },
    ],
    minimum: 997_500n,
    selected: {},
    gas: { evmGasType: EVMGasType.Type1, gasEstimate: 1_000_000n, gasPrice: 1n },
    fee: {},
  } as unknown as Parameters<typeof executeUnshield>[1]
  state.reconcile.mockResolvedValue('Input spent; output unconfirmed')
  await expect(
    executeUnshield(session, prepared, () => {}, { assertReady: async () => {}, send: async () => hash }),
  ).rejects.toThrow(/output and nullifiers are not confirmed/)
  expect(state.save).toHaveBeenCalled()
  expect(state.reconcile).not.toHaveBeenCalled()
})
