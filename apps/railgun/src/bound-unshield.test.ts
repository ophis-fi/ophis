import { beforeEach, expect, it, vi } from 'vitest'
import { EVMGasType } from '@railgun-community/shared-models'
import { CHAIN, CONFIG, TOKENS, registerToken } from './config'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ save: vi.fn(), simulate: vi.fn(), sign: vi.fn(), proof: vi.fn(), derive: vi.fn(), events: [] as string[] }))
vi.mock('@railgun-community/wallet', () => ({
  fullWalletForID: () => ({ sign7702Request: state.sign }),
  generateCrossContractCallsProof7702: state.proof,
}))
vi.mock('./withdrawal-journal', () => ({ savePendingWithdrawal: state.save }))
vi.mock('./execution', () => ({
  assertSameExecution: vi.fn(), assertBoundWithdrawal: vi.fn(),
  encodeRequest: () => ({ data: '0x1234' }), simulateRequest: state.simulate,
}))
vi.mock('./wallet', () => ({}))
vi.mock('./broadcaster', () => ({}))
vi.mock('./recipe', () => ({}))

import { executeBoundWithdrawal, type PreparedBoundWithdrawal } from './bound-unshield'

const account = '0x0000000000000000000000000000000000001234'
const otherAccount = '0x0000000000000000000000000000000000005678'
const token = registerToken({ address: '0x0000000000000000000000000000000000004321', symbol: 'CUSTOM', decimals: 8 })
// Synthetic signature structure only; no owner keys or proofs are loaded.
const signature = { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, v: 27 }
const authorization = { address: CONFIG.relayAdapt7702Contract, chainId: CHAIN, nonce: 0n, signature }
const prepared = {
  kind: 'TX7702', token, feeToken: 'WETH', account, index: 7,
  amounts: [{ tokenAddress: token, amount: 100_000_000n, recipientAddress: otherAccount }],
  minimum: 99_750_000n, selected: { railgunAddress: 'synthetic-fee-recipient', tokenAddress: TOKENS.WETH.address,
    tokenFee: { expiration: Date.now() + 600_000, feesID: 'synthetic-fee', availableWallets: 1, reliability: 1,
      feePerUnitGas: '1000000000000000000', relayAdapt: CONFIG.relayAdaptContract, relayAdapt7702: CONFIG.relayAdapt7702Contract } },
  gas: { evmGasType: EVMGasType.Type4, gasEstimate: 3_000_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n },
  fee: { tokenAddress: TOKENS.WETH.address, amount: 1n, recipientAddress: 'synthetic-fee-recipient' },
  feeBps: 25n, calls: [],
} as PreparedBoundWithdrawal
const session = {
  info: { id: 'synthetic-wallet' }, key: 'synthetic-key',
  accounts: { getAccount: state.derive },
  provider: { getBlockNumber: async () => 100, call: async () => `0x${'19'.padStart(64, '0')}` },
} as unknown as WalletSession

beforeEach(() => {
  vi.resetAllMocks()
  state.events = []
  state.derive.mockResolvedValue({ address: account })
  state.proof.mockResolvedValue({ ephemeralAddress: account, executeNonce: 0n, authorization,
    actionData: { requireSuccess: false }, transactions: [{ nullifiers: ['11'.repeat(32)] }] })
  state.sign.mockResolvedValue({ authorization, signature })
  state.save.mockImplementation(async () => { state.events.push('saved') })
  state.simulate.mockImplementation(async () => { state.events.push('disclosed'); throw new Error('Synthetic simulation stopped') })
})

it('rejects a fallback zero recovery index when the proof uses the selected nonzero account', async () => {
  state.derive.mockResolvedValue({ address: otherAccount })
  const send = vi.fn()
  await expect(executeBoundWithdrawal(session, { ...prepared, index: 0 }, () => {}, { assertReady: async () => {}, send }))
    .rejects.toThrow('Recovery account does not match the signed transaction')
  expect(state.derive).toHaveBeenCalledWith(CHAIN, 0)
  expect(state.sign).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
  expect(state.simulate).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('fails closed if the recovery account cannot be derived', async () => {
  state.derive.mockRejectedValue(new Error('Synthetic derivation failure'))
  const send = vi.fn()
  await expect(executeBoundWithdrawal(session, prepared, () => {}, { assertReady: async () => {}, send }))
    .rejects.toThrow('Synthetic derivation failure')
  expect(state.save).not.toHaveBeenCalled()
  expect(state.simulate).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('builds a fee-free prepaid principal proof, re-signs strict execution, and journals its mode before disclosure', async () => {
  const prepaid = { feesID: 'synthetic-reviewed-credit' } as NonNullable<PreparedBoundWithdrawal['prepaid']>
  const ready = vi.fn(), send = vi.fn()
  await expect(executeBoundWithdrawal(session, { ...prepared, prepaid }, () => {}, { assertReady: ready, send })).rejects.toThrow('Synthetic simulation stopped')
  expect(state.proof.mock.calls[0][9]).toBeUndefined()
  expect(state.proof.mock.calls[0][10]).toBe(true)
  expect(state.sign.mock.calls[0][4]).toMatchObject({ requireSuccess: true })
  expect(ready.mock.calls.every((args) => args[3] === prepaid)).toBe(true)
  expect(state.save.mock.calls[0][1]).toMatchObject({ feeMode: 'prepaid', feeToken: 'WETH', execution: { index: 7 } })
  expect(state.events).toEqual(['saved', 'disclosed'])
  expect(send).not.toHaveBeenCalled()
})

it('persists the matching recovery index before disclosure and keeps it after simulation failure', async () => {
  const send = vi.fn()
  await expect(executeBoundWithdrawal(session, prepared, () => {}, { assertReady: async () => {}, send }))
    .rejects.toThrow('Synthetic simulation stopped')
  expect(state.derive).toHaveBeenCalledWith(CHAIN, 7)
  expect(state.save).toHaveBeenCalledWith(session, expect.objectContaining({ execution: expect.objectContaining({ index: 7, account }) }))
  expect(state.sign.mock.calls[0][4]).toMatchObject({ requireSuccess: true })
  expect(state.events).toEqual(['saved', 'disclosed'])
  expect(send).not.toHaveBeenCalled()
})
