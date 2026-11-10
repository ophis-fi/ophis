import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVMGasType, type RailgunPopulateTransactionResponse, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { Wallet } from 'ethers'
import type { WalletSession } from './wallet'
import { withdrawalData } from '../tests/withdrawal.fixture'

const state = vi.hoisted(() => ({
  policy: {} as Record<number, { railgunAddress: string; expiresAt: number }[]>,
  start: vi.fn(), find: vi.fn(), create: vi.fn(), send: vi.fn(),
}))
vi.mock('./config', async (original) => ({
  ...await original<typeof import('./config')>(), ENVIRONMENT: 'ethereum', PROTECTED_BROADCASTERS: state.policy,
  // These legacy transport regressions model another operator. The actual
  // Ophis pin is tested separately and cannot use this unsecured transport.
  OPHIS_BROADCASTER: 'synthetic-different-prepaid-operator',
}))
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({
  WakuBroadcasterClient: { isStarted: () => true, start: state.start, findBroadcastersForToken: state.find },
  BroadcasterTransaction: { create: state.create },
}))
import { selectBroadcaster, submitPrivate, validateBroadcaster } from './broadcaster'
import { CONFIG, FEE_SIGNER, TOKENS, registerToken, tokenFor } from './config'
import { usesBoundWithdrawal } from './fee-asset'

const selected: SelectedBroadcaster = {
  railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
  tokenFee: { expiration: Date.now() + 600_000, feesID: 'verified-test-fee', feePerUnitGas: '10',
    availableWallets: 1, relayAdapt: '', relayAdapt7702: CONFIG.relayAdapt7702Contract, reliability: 1 },
}
const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: 3_000_000n, maxFeePerGas: 101n, maxPriorityFeePerGas: 1n }
const authorization = await Wallet.createRandom().authorize({ address: CONFIG.relayAdapt7702Contract, chainId: 1, nonce: 0 })
const populated: RailgunPopulateTransactionResponse = {
  transaction: { to: authorization.address, data: '0x1234', authorizationList: [authorization] },
  nullifiers: ['local-test-nullifier'], preTransactionPOIsPerTxidLeafPerList: {},
}
const session = { provider: {
  send: vi.fn().mockResolvedValue(undefined),
  getNetwork: async () => ({ chainId: 1n }), getBlock: async () => ({ baseFeePerGas: 100n }),
} } as unknown as WalletSession

beforeEach(() => {
  vi.clearAllMocks()
  for (const chain of Object.keys(state.policy)) delete state.policy[Number(chain)]
  state.policy[1] = [{ railgunAddress: FEE_SIGNER, expiresAt: Date.now() + 3_600_000 }]
  state.find.mockReturnValue([selected])
  state.create.mockReset().mockResolvedValue({ send: state.send })
  state.send.mockReset().mockResolvedValue('0xprotected-test-hash')
})
afterEach(() => vi.restoreAllMocks())

it('fails before discovery and encrypted submission if no operator is approved', async () => {
  delete state.policy[1]
  await expect(selectBroadcaster(selected.tokenAddress, true, vi.fn())).rejects.toThrow(/not available/)
  await expect(submitPrivate(session, populated, selected, gas, true, freshCheck())).rejects.toThrow(/not approved/)
  expect(state.start).not.toHaveBeenCalled()
  expect(state.find).not.toHaveBeenCalled()
  expect(session.provider.send).not.toHaveBeenCalled()
  expect(state.create).not.toHaveBeenCalled()
})

it('cannot reuse another chain approval or an expired operator policy', () => {
  state.policy[42161] = state.policy[1]
  delete state.policy[1]
  expect(() => validateBroadcaster(selected, selected.tokenAddress, true)).toThrow(/not approved/)
  state.policy[1] = [{ railgunAddress: FEE_SIGNER, expiresAt: Date.now() }]
  expect(() => validateBroadcaster(selected, selected.tokenAddress, true)).toThrow(/not approved/)
  state.policy[1] = [{ railgunAddress: FEE_SIGNER, expiresAt: Date.now() + 600_000 }]
  expect(() => validateBroadcaster(selected, selected.tokenAddress, true)).toThrow(/not approved/)
})

it('preserves common withdrawal discovery and submission when protected swaps are unavailable', async () => {
  delete state.policy[1]
  await expect(selectBroadcaster(selected.tokenAddress, false, vi.fn())).resolves.toBe(selected)
  const withdrawal = { ...populated, transaction: { to: CONFIG.proxyContract, data: withdrawalData() } }
  await expect(submitPrivate(session, withdrawal, selected, {
    evmGasType: EVMGasType.Type1, gasEstimate: 3_000_000n, gasPrice: 101n,
  }, false)).resolves.toBe('0xprotected-test-hash')
})

it('holds Ethereum imported-token withdrawals at the approval safety cutoff while COMMON discovery remains available', async () => {
  const token = registerToken({ address: '0x0000000000000000000000000000000000001234', symbol: 'CUSTOM', decimals: 18 })
  expect(usesBoundWithdrawal(token)).toBe(true)
  state.policy[1] = [{ railgunAddress: FEE_SIGNER, expiresAt: Date.now() + 15 * 60_000 }]
  await expect(selectBroadcaster(tokenFor(token).address, true, vi.fn())).rejects.toThrow(/withdrawals with fees paid in another token/)
  expect(state.find).not.toHaveBeenCalled()
  await expect(selectBroadcaster(selected.tokenAddress, false, vi.fn())).resolves.toBe(selected)
})

it('cannot bypass the protected swap gate by labelling a delegated call as a common withdrawal', async () => {
  delete state.policy[1]
  await expect(submitPrivate(session, populated, selected, {
    evmGasType: EVMGasType.Type1, gasEstimate: 3_000_000n, gasPrice: 101n,
  }, false)).rejects.toThrow(/Common submissions must be withdrawals/)
  expect(state.create).not.toHaveBeenCalled()
  expect(state.send).not.toHaveBeenCalled()
})

it('does not submit a signed swap if its final price check is missing or expires during encryption', async () => {
  await expect(submitPrivate(session, populated, selected, gas, true)).rejects.toThrow(/Final price check expired/)
  expect(state.create).not.toHaveBeenCalled()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  state.create.mockImplementationOnce(async () => { clock.mockReturnValue(31_000); return { send: state.send } })
  await expect(submitPrivate(session, populated, selected, gas, true, freshCheck())).rejects.toThrow(/Final price check expired/)
  expect(state.send).not.toHaveBeenCalled()
})

it('rechecks operator approval immediately before sending', async () => {
  state.create.mockImplementationOnce(async () => { delete state.policy[1]; return { send: state.send } })
  await expect(submitPrivate(session, populated, selected, gas, true, freshCheck())).rejects.toThrow(/not approved/)
  expect(state.send).not.toHaveBeenCalled()
})

it.each(['Request timed out', 'RPC rejected transaction'])('does not switch operator or send a raw transaction as an app fallback after %s', async (message) => {
  state.send.mockRejectedValueOnce(new Error(message))
  await expect(submitPrivate(session, populated, selected, gas, true, freshCheck())).rejects.toThrow(message)
  expect(state.create).toHaveBeenCalledOnce()
  expect(state.create.mock.calls[0][3]).toBe(FEE_SIGNER)
  expect(state.send).toHaveBeenCalledOnce()
  expect(vi.mocked(session.provider.send).mock.calls.map(([method]) => method)).toEqual(['anvil_metadata', 'hardhat_metadata'])
})

function freshCheck() { return { monotonic: performance.now(), wallTime: Date.now() } }
