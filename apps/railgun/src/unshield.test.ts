import { expect, it, vi } from 'vitest'
import { EVMGasType } from '@railgun-community/shared-models'
import { ZeroAddress } from 'ethers'
import { CONFIG, TOKENS } from './config'
import type { WalletSession } from './wallet'
import { withdrawalData } from '../tests/withdrawal.fixture'
import type { PrivateSubmitter } from './broadcaster'

const state = vi.hoisted(() => ({ reconcile: vi.fn(), save: vi.fn(), select: vi.fn(), count: 1, pending: undefined as unknown, spent: false }))
vi.mock('./storage', () => ({}))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn() }))
vi.mock('./broadcaster', () => ({ broadcasterFee: vi.fn(), validateBroadcaster: vi.fn(), selectBroadcaster: state.select }))
vi.mock('./withdrawal-journal', async (original) => ({
  ...(await original<typeof import('./withdrawal-journal')>()),
  pendingWithdrawal: async () => state.pending,
  withdrawalInputsSpent: async () => state.spent,
  savePendingWithdrawal: state.save,
  reconcilePendingWithdrawal: state.reconcile,
}))
vi.mock('@railgun-community/wallet', () => ({
  generateUnshieldProof: async () => {},
  populateProvedUnshield: async () => ({
    transaction: { to: CONFIG.proxyContract, data: withdrawalData(state.count, 1, ZeroAddress, TOKENS.USDC.address) },
    nullifiers: [`0x${'11'.repeat(32)}`],
  }),
  gasEstimateForUnprovenUnshield: vi.fn(),
  getWalletTransactionHistory: vi.fn(),
}))
import { executeUnshield, retrySavedUnshield } from './unshield'

it('rejects a prepared withdrawal during history synchronization before recording or disclosing a spend', async () => {
  const { requireWalletSync } = await import('./wallet')
  vi.mocked(requireWalletSync).mockImplementationOnce(() => { throw new Error('Wallet history is synchronizing') })
  state.save.mockClear()
  const send = vi.fn(), ready = vi.fn()
  await expect(executeUnshield({} as WalletSession, {} as Parameters<typeof executeUnshield>[1], () => {}, { assertReady: ready, send }))
    .rejects.toThrow('synchronizing')
  expect(state.save).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('retries the saved proof through the broadcaster without proving again, and blocks known or spent submissions', async () => {
  const transaction = { to: CONFIG.proxyContract, data: withdrawalData(1, 1, ZeroAddress, TOKENS.USDC.address), value: '0' }
  const saved = { transaction, token: 'USDC', minGasPrice: '100', nullifiers: [`0x${'11'.repeat(32)}`] }
  state.pending = saved
  state.select.mockResolvedValue({ tokenAddress: TOKENS.USDC.address })
  const send = vi.fn<PrivateSubmitter['send']>(async () => `0x${'33'.repeat(32)}`)
  const session = { provider: { waitForTransaction: async () => undefined } } as unknown as WalletSession
  try {
    await expect(retrySavedUnshield(session, () => {}, { assertReady: vi.fn(), send })).rejects.toThrow('Withdrawal unconfirmed')
    expect(send.mock.calls[0][1].transaction.data).toBe(transaction.data)
    expect(state.save).toHaveBeenCalledWith(session, expect.objectContaining({ transaction, hash: `0x${'33'.repeat(32)}` }))
    send.mockClear()
    state.pending = { ...saved, hash: `0x${'44'.repeat(32)}` }
    await expect(retrySavedUnshield(session, () => {}, { assertReady: vi.fn(), send })).rejects.toThrow('hash is already saved')
    state.pending = saved; state.spent = true
    await expect(retrySavedUnshield(session, () => {}, { assertReady: vi.fn(), send })).rejects.toThrow('input is already spent')
    expect(send).not.toHaveBeenCalled()
  } finally { state.pending = undefined; state.spent = false }
})

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

it('rejects separable fee proofs before recording or disclosing a new withdrawal', async () => {
  state.count = 2
  state.save.mockClear()
  const send = vi.fn()
  const session = { info: { id: 'test' }, provider: { getBlockNumber: async () => 100 } } as unknown as WalletSession
  const prepared = { amounts: [{ recipientAddress: '0x0000000000000000000000000000000000001234' }],
    token: 'USDC', minimum: 1n, selected: {}, gas: { gasPrice: 1n }, fee: {} } as unknown as Parameters<typeof executeUnshield>[1]
  try {
    await expect(executeUnshield(session, prepared, () => {}, { assertReady: async () => {}, send }))
      .rejects.toThrow(/must share one proof/)
    expect(state.save).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  } finally { state.count = 1 }
})
