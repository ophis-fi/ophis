import { beforeEach, expect, it, vi } from 'vitest'
import type { JsonRpcSigner } from 'ethers'
import { CHAIN, CHAIN_ID, CONFIG, TOKENS } from './config'
import { withdrawalData } from '../tests/withdrawal.fixture'
import { PRIVACY } from './execution'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ pending: undefined as unknown, changed: false, save: vi.fn(), send: vi.fn(), fees: vi.fn() }))
vi.mock('./storage', () => ({ readPrivateState: async () => state.pending, writePrivateState: state.save, deletePrivateState: vi.fn() }))
vi.mock('./shield', () => ({ assertPublicNetwork: async (_session: unknown, _signer: unknown, beforeSend?: () => void) => {
  if (state.changed) throw new Error('Public wallet changed')
  beforeSend?.()
} }))
import { resumePendingWithdrawal } from './withdrawal-journal'

const session = { provider: { getFeeData: state.fees } } as unknown as WalletSession
const signer = { sendTransaction: state.send } as unknown as JsonRpcSigner
beforeEach(() => {
  vi.clearAllMocks(); state.changed = false
  const [transactions] = PRIVACY.decodeFunctionData('transact', withdrawalData(1, 1,
    '0x0000000000000000000000000000000000001234', TOKENS.USDC.address))
  const data = PRIVACY.encodeFunctionData('transact', [[{ ...transactions[0].toObject(),
    boundParams: { ...transactions[0].boundParams.toObject(), chainID: CHAIN } }]])
  state.pending = { chainId: CHAIN_ID, token: 'USDC', recipient: '0x0000000000000000000000000000000000001234',
    minimum: '997', fromBlock: 1, nullifiers: [`0x${'11'.repeat(32)}`], minGasPrice: '1',
    transaction: { to: CONFIG.proxyContract, data, value: '0' } }
  state.fees.mockResolvedValue({ gasPrice: 10n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })
  state.send.mockRejectedValue(new Error('Dummy wallet stopped before signing'))
})
it('binds a resumed COMMON withdrawal to its selected chain', async () => {
  await expect(resumePendingWithdrawal(session, signer)).rejects.toThrow('Dummy wallet stopped')
  expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ chainId: CHAIN, type: CHAIN_ID === 56 ? 0 : 2 }))
  expect(state.save).not.toHaveBeenCalled()
})
it('rejects wallet changes while gas data is loading and keeps the proof', async () => {
  const original = structuredClone(state.pending)
  state.fees.mockImplementation(async () => { state.changed = true; return { gasPrice: 10n } })
  await expect(resumePendingWithdrawal(session, signer)).rejects.toThrow('Public wallet changed')
  expect(state.send).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
  expect(state.pending).toEqual(original)
})
it('checks the captured session immediately before dispatch', async () => {
  const beforeSend = () => { throw new Error('Session changed') }
  await expect(resumePendingWithdrawal(session, signer, beforeSend)).rejects.toThrow('Session changed')
  expect(state.send).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
})
