import { beforeEach, expect, it, vi } from 'vitest'
import type { WalletSession } from './wallet'
import type { PrivateSubmitter } from './broadcaster'

const state = vi.hoisted(() => ({ events: [] as string[], save: vi.fn(), simulate: vi.fn(), requote: vi.fn() }))
const account = '0x0000000000000000000000000000000000001234'
vi.mock('./broadcaster', () => ({ broadcasterFee: vi.fn(), validateBroadcaster: vi.fn() }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn() }))
vi.mock('./journal', () => ({
  pendingSwap: async () => undefined,
  savePendingSwap: state.save,
  reconcilePendingSwap: vi.fn(),
}))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => undefined }))
vi.mock('./recipe', async (original) => ({ ...await original<typeof import('./recipe')>(), revalidateSwapQuote: state.requote }))
vi.mock('./execution', () => ({
  assertExecutionNetwork: vi.fn(),
  assertSameExecution: vi.fn(),
  expectedOutputNpk: () => `0x${'aa'.repeat(32)}`,
  simulateRequest: state.simulate,
}))
vi.mock('@railgun-community/wallet', () => ({
  fullWalletForID: () => ({ getEphemeralKeyIndex: async () => 3 }),
  generateCrossContractCallsProof7702: async () => ({
    ephemeralAddress: '0x0000000000000000000000000000000000001234',
    executeNonce: 0n,
    transactions: [{ boundParams: { treeNumber: 0 }, nullifiers: ['11'.repeat(32)] }],
  }),
  populateProvedCrossContractCalls: async () => ({ transaction: {}, nullifiers: ['11'.repeat(32)] }),
  ratchetEphemeralAddress: vi.fn(),
}))
import { executePrivateSwap } from './private-swap'

const session = {
  info: { id: 'test-wallet' },
  accounts: { getCurrentAccount: async () => ({ address: account }), getAccount: async () => ({ address: account }) },
  provider: { getBlockNumber: async () => 100 },
} as unknown as WalletSession
const prepared = {
  quote: { chainId: 1, account, deadline: Math.floor(Date.now() / 1000) + 600, sell: 'USDC', buy: 'WETH', minimum: 100n, shieldFee: 25n },
  selected: {},
  gas: { gasEstimate: 3_000_000n },
  fee: {},
  unshields: [],
  reshields: [],
} as unknown as Parameters<typeof executePrivateSwap>[1]

beforeEach(() => {
  vi.clearAllMocks()
  prepared.quote.deadline = Math.floor(Date.now() / 1000) + 600
  state.events = []
  state.requote.mockImplementation(async () => ({ monotonic: performance.now(), wallTime: Date.now() }))
  state.save.mockImplementation(async () => {
    state.events.push('saved')
  })
  state.simulate.mockImplementation(async () => {
    state.events.push('disclosed')
    throw new Error('RPC failed during simulation')
  })
})

it('persists recovery before disclosing a signed spend and retains it after simulation failure', async () => {
  const send = vi.fn()
  const submitter: PrivateSubmitter = { assertReady: async () => {}, send }
  await expect(executePrivateSwap(session, prepared, () => {}, submitter)).rejects.toThrow(/RPC failed/)
  expect(state.events).toEqual(['saved', 'disclosed'])
  expect(state.save.mock.calls[0][1]).toMatchObject({ index: 3, account, executeNonce: '0', inputs: [{ tree: 0, nullifier: `0x${'11'.repeat(32)}` }] })
  expect(send).not.toHaveBeenCalled()
})

it('rejects a prepared swap during history synchronization before recording or disclosing a spend', async () => {
  const { requireWalletSync } = await import('./wallet')
  vi.mocked(requireWalletSync).mockImplementationOnce(() => { throw new Error('Wallet history is synchronizing') })
  const send = vi.fn(), ready = vi.fn()
  await expect(executePrivateSwap(session, prepared, () => {}, { assertReady: ready, send })).rejects.toThrow('synchronizing')
  expect(state.save).not.toHaveBeenCalled()
  expect(state.simulate).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('checks transport readiness again after proving before recording or disclosing the spend', async () => {
  const ready = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Fee expired'))
  await expect(executePrivateSwap(session, prepared, () => {}, { assertReady: ready, send: vi.fn() })).rejects.toThrow(
    /Fee expired/,
  )
  expect(state.save).not.toHaveBeenCalled()
  expect(state.simulate).not.toHaveBeenCalled()
})

it('does not send a quote that expires during simulation, and retains recovery', async () => {
  const send = vi.fn()
  state.simulate.mockImplementationOnce(async () => { prepared.quote.deadline = 1 })
  await expect(executePrivateSwap(session, prepared, () => {}, { assertReady: async () => {}, send })).rejects.toThrow(/expired/)
  expect(state.save).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
})

it('checks the price after proving and rejects movement before recording or disclosing the signed spend', async () => {
  state.requote.mockRejectedValueOnce(new Error('Price moved outside the proved limits'))
  const send = vi.fn()
  await expect(executePrivateSwap(session, prepared, () => {}, { assertReady: async () => {}, send })).rejects.toThrow(/Price moved/)
  expect(state.requote).toHaveBeenCalledWith(session.provider, prepared.quote)
  expect(state.save).not.toHaveBeenCalled()
  expect(state.simulate).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('retains recovery without sending if the final price check ages during signed simulation', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const send = vi.fn()
  state.simulate.mockImplementationOnce(async () => { clock.mockReturnValue(31_000) })
  try {
    await expect(executePrivateSwap(session, prepared, () => {}, { assertReady: async () => {}, send })).rejects.toThrow(/Final price check expired/)
    expect(state.save).toHaveBeenCalledOnce()
    expect(state.simulate).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  } finally { clock.mockRestore() }
})
