import { beforeEach, expect, it, vi } from 'vitest'
import type { WalletSession } from './wallet'
import type { PrivateSubmitter } from './broadcaster'

const state = vi.hoisted(() => ({ events: [] as string[], save: vi.fn(), simulate: vi.fn() }))
const account = '0x0000000000000000000000000000000000001234'
vi.mock('./broadcaster', () => ({ broadcasterFee: vi.fn() }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn() }))
vi.mock('./journal', () => ({
  pendingSwap: async () => undefined,
  savePendingSwap: state.save,
  reconcilePendingSwap: vi.fn(),
}))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => undefined }))
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
  }),
  populateProvedCrossContractCalls: async () => ({ transaction: {} }),
  ratchetEphemeralAddress: vi.fn(),
}))
import { executePrivateSwap } from './private-swap'

const session = {
  info: { id: 'test-wallet' },
  accounts: { getCurrentAccount: async () => ({ address: account }), getAccount: async () => ({ address: account }) },
  provider: { getBlockNumber: async () => 100 },
} as unknown as WalletSession
const prepared = {
  quote: { account, deadline: Math.floor(Date.now() / 1000) + 600, buy: 'WETH', minimum: 100n, shieldFee: 25n },
  selected: {},
  gas: { gasEstimate: 3_000_000n },
  fee: {},
  unshields: [],
  reshields: [],
} as unknown as Parameters<typeof executePrivateSwap>[1]

beforeEach(() => {
  vi.clearAllMocks()
  state.events = []
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
  expect(state.save.mock.calls[0][1]).toMatchObject({ index: 3, account, executeNonce: '0' })
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
