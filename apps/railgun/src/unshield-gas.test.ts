import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVMGasType, getEVMGasTypeForTransaction, type SelectedBroadcaster } from '@railgun-community/shared-models'
import type { WalletSession } from './wallet'
import { withdrawalData } from '../tests/withdrawal.fixture'

const state = vi.hoisted(() => ({ estimate: vi.fn(), create: vi.fn(), send: vi.fn(), balance: 10_000_000n, pilot: undefined as string | undefined }))
vi.mock('ethers', async (original) => ({
  ...await original<typeof import('ethers')>(),
  Contract: class { getFunction() { return async () => 25n } },
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...await original<typeof import('@railgun-community/wallet')>(), gasEstimateForUnprovenUnshield: state.estimate,
  fullWalletForID: () => ({}), balanceForERC20Token: async () => state.balance,
}))
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({
  WakuBroadcasterClient: {}, BroadcasterTransaction: { create: state.create },
}))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn(), refreshReceivedBalances: vi.fn() }))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined }))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => undefined }))

beforeEach(() => {
  vi.resetModules()
  vi.doUnmock('./config')
  vi.doMock('./config', async (original) => ({ ...await original<typeof import('./config')>(), PROTECTED_BROADCASTERS: {},
    get PILOT_WITHDRAWAL_RECIPIENT() { return state.pilot } }))
  vi.clearAllMocks()
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'mainnet')
  state.estimate.mockResolvedValue({ gasEstimate: 100_000n })
  state.create.mockResolvedValue({ send: state.send })
  state.send.mockResolvedValue('withdrawal-test-hash')
  state.balance = 10_000_000n
  state.pilot = undefined
})

it('reserves the USDC broadcaster fee from a full-balance withdrawal and rounds estimate jitter conservatively', async () => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '1')
  const { TOKENS, FEE_SIGNER } = await import('./config')
  const { prepareUnshield } = await import('./unshield')
  const selected = { railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.USDC.address,
    tokenFee: { expiration: Date.now() + 600_000, feePerUnitGas: '1000000000000' } } as SelectedBroadcaster
  const session = { info: { id: 'test' }, key: 'test',
    accounts: { getCurrentAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) },
    provider: { getFeeData: async () => ({ gasPrice: 100n }), getBlock: async () => ({ baseFeePerGas: 0n }) } } as unknown as WalletSession
  state.estimate.mockResolvedValueOnce({ gasEstimate: 100_001n }).mockResolvedValue({ gasEstimate: 100_009n })
  const result = await prepareUnshield(session, 'USDC', '', '0x0000000000000000000000000000000000005678', selected, true)
  expect(result.amounts[0].amount + result.fee.amount).toBe(state.balance)
  expect(result.gas.gasEstimate).toBe(110_000n)
  expect(result.fee.tokenAddress).toBe(TOKENS.USDC.address)
  expect(result.minimum).toBeLessThan(result.amounts[0].amount)
  expect(state.estimate).toHaveBeenCalledTimes(2)
  await expect(prepareUnshield(session, 'USDC', '10', '0x0000000000000000000000000000000000005678', selected))
    .rejects.toThrow('Insufficient spendable USDC')
  state.balance = 1n
  await expect(prepareUnshield(session, 'USDC', '', '0x0000000000000000000000000000000000005678', selected, true))
    .rejects.toThrow('Insufficient spendable USDC')
})
afterEach(() => vi.unstubAllEnvs())

it('covers the broadcaster positive-tip floor when Ethereum suggests only its base fee', async () => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '1')
  const { TOKENS, FEE_SIGNER } = await import('./config')
  const { prepareUnshield } = await import('./unshield')
  state.balance = 10n ** 18n
  const selected = { railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
    tokenFee: { expiration: Date.now() + 600_000, feePerUnitGas: '1150000000000000000' } } as SelectedBroadcaster
  const block = vi.fn(async (): Promise<{ baseFeePerGas: bigint } | null> => ({ baseFeePerGas: 7n }))
  const session = { info: { id: 'test' }, key: 'test',
    accounts: { getCurrentAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) },
    provider: { getFeeData: async () => ({ gasPrice: 7n }), getBlock: block } } as unknown as WalletSession
  const result = await prepareUnshield(session, 'WETH', '0.001', '0x0000000000000000000000000000000000005678', selected)
  if (result.kind !== 'COMMON') throw new Error('Expected a common WETH withdrawal')
  expect(result.gas.gasPrice).toBe(8n)
  expect(state.estimate.mock.calls[0][6].gasPrice).toBe(8n)
  // Backend's full 110%-padded budget at eight wei, including the 15% margin.
  expect(result.fee.amount).toBeGreaterThanOrEqual(1_012_000n)
  state.estimate.mockClear(); block.mockResolvedValue(null)
  await expect(prepareUnshield(session, 'WETH', '0.001', '0x0000000000000000000000000000000000005678', selected))
    .rejects.toThrow('base fee unavailable')
  expect(state.estimate).not.toHaveBeenCalled()
})

it('rejects a WETH quote before proving for the USDC withdrawal pilot', async () => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '1')
  const { TOKENS, FEE_SIGNER } = await import('./config')
  const { prepareUnshield } = await import('./unshield')
  state.pilot = '0x0000000000000000000000000000000000005678'
  const selected = { railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
    tokenFee: { expiration: Date.now() + 600_000, feePerUnitGas: '1000000000000000000' } } as SelectedBroadcaster
  const session = { accounts: { getCurrentAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) } } as unknown as WalletSession
  await expect(prepareUnshield(session, 'WETH', '0.001', state.pilot, selected)).rejects.toThrow('Choose USDC before preparing a proof')
  expect(state.estimate).not.toHaveBeenCalled()
})

it.each([1, 42161, 137, 56])('prepares and submits chain %s withdrawals with SDK gas policy when no swap operator is approved', async (chainId) => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', String(chainId))
  const { CONFIG, FEE_SIGNER, NETWORK, PROTECTED_BROADCASTERS, TOKENS } = await import('./config')
  const { prepareUnshield } = await import('./unshield')
  const { submitPrivate } = await import('./broadcaster')
  const session = {
    info: { id: 'local-test-wallet' }, key: 'local-test-only',
    accounts: { getCurrentAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) },
    provider: { getFeeData: async () => ({ gasPrice: 100n }),
      getBlock: async () => ({ baseFeePerGas: 0n }),
      getNetwork: async () => ({ chainId: BigInt(chainId) }), send: async () => undefined },
  } as unknown as WalletSession
  const selected: SelectedBroadcaster = {
    railgunAddress: FEE_SIGNER, tokenAddress: chainId === 56 ? TOKENS.WBNB.address : TOKENS.USDC.address,
    tokenFee: { expiration: Date.now() + 600_000, feesID: 'test-fee', feePerUnitGas: '1000000000000',
      availableWallets: 1, relayAdapt: '', reliability: 1 },
  }
  expect(PROTECTED_BROADCASTERS[chainId]).toBeUndefined()
  state.balance = 10n ** BigInt(TOKENS.USDC.decimals + 1)
  const token = chainId === 56 ? 'WBNB' : 'USDC'
  const prepared = await prepareUnshield(session, token, '1', '0x0000000000000000000000000000000000005678', selected)
  if (prepared.kind !== 'COMMON') throw new Error('Expected a same-asset common withdrawal')
  const expectedType = chainId === 56 ? EVMGasType.Type0 : EVMGasType.Type1
  expect(prepared.gas.evmGasType).toBe(expectedType)
  expect(prepared.gas.evmGasType).toBe(getEVMGasTypeForTransaction(NETWORK, false))
  expect(state.estimate.mock.calls[0][6].evmGasType).toBe(expectedType)
  const populated = { transaction: { to: CONFIG.proxyContract, data: withdrawalData(1, 1, '0x0000000000000000000000000000000000005678', TOKENS[token].address) },
    nullifiers: ['test-nullifier'] } as Parameters<typeof submitPrivate>[1]
  await expect(submitPrivate(session, populated, selected, prepared.gas, false)).resolves.toBe('withdrawal-test-hash')
  const wrongType = expectedType === EVMGasType.Type0 ? EVMGasType.Type1 : EVMGasType.Type0
  await expect(submitPrivate(session, populated, selected, { ...prepared.gas, evmGasType: wrongType }, false))
    .rejects.toThrow(/Common submissions must be withdrawals/)
  expect(state.send).toHaveBeenCalledOnce()
  expect(state.create.mock.calls[0][9]).toEqual({})
})
