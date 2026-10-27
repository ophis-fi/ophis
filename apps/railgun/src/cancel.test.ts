import { beforeEach, expect, it, vi } from 'vitest'
import { CONFIG } from './config'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({
  nonce: vi.fn(), remove: vi.fn(), ratchet: vi.fn(), confirmedNonce: 0n, confirmedCode: '',
}))
const delegation = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`
const account = '0x0000000000000000000000000000000000001234'
vi.mock('ethers', async (original) => ({
  ...(await original<typeof import('ethers')>()),
  Contract: class { getFunction = () => state.nonce },
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  fullWalletForID: () => ({ setEphemeralKeyIndexIfGreater: state.ratchet }),
}))
vi.mock('./storage', () => ({
  readPrivateState: async () => ({ index: 3, account, token: 'WETH', minimum: '1',
    npk: `0x${'11'.repeat(32)}`, executeNonce: '0', fromBlock: 90 }),
  deletePrivateState: state.remove,
}))
import { cancelPendingSwap } from './cancel'

const session = {
  info: { id: 'test' },
  provider: {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async (_address: string, block?: number) => block === 100 ? state.confirmedCode : delegation,
    send: async () => '0x65',
  },
  accounts: { getAccount: async () => ({ address: account }) },
} as unknown as WalletSession

beforeEach(() => {
  vi.clearAllMocks()
  state.confirmedCode = delegation
  state.confirmedNonce = 0n
  state.nonce.mockImplementation(async (options?: { blockTag: number }) =>
    options?.blockTag === 100 ? state.confirmedNonce : 1n)
})

it.each(['0x', delegation])('retains the journal while latest nonce advancement is unconfirmed (%s)', async (code) => {
  state.confirmedCode = code
  await expect(cancelPendingSwap(session, true)).rejects.toThrow(/confirm/)
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.ratchet).not.toHaveBeenCalled()
})

it('clears only after the old authorization is invalid at the two-confirmation block', async () => {
  state.confirmedNonce = 1n
  await expect(cancelPendingSwap(session, true)).resolves.toMatch(/invalidated/)
  expect(state.nonce).toHaveBeenCalledWith({ blockTag: 100 })
  expect(state.ratchet).toHaveBeenCalledWith(1n, 4)
  expect(state.remove).toHaveBeenCalledOnce()
})
