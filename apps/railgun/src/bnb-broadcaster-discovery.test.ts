import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import type { WalletSession } from './wallet'
import { withdrawalData } from '../tests/withdrawal.fixture'

const mocks = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), send: vi.fn(),
  policy: {} as Record<number, { railgunAddress: string; expiresAt: number; maxGasPrice: bigint; maxTransactionCost: bigint }[]> }))
vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(), PROTECTED_BROADCASTERS: mocks.policy }))
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({
  WakuBroadcasterClient: { isStarted: () => true, findBroadcastersForToken: mocks.find },
  BroadcasterTransaction: { create: mocks.create },
}))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '56')
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'ethereum')
  for (const chain of Object.keys(mocks.policy)) delete mocks.policy[Number(chain)]
  mocks.find.mockReturnValue([])
  mocks.create.mockReset().mockResolvedValue({ send: mocks.send })
  mocks.send.mockReset().mockResolvedValue('synthetic-withdrawal-hash')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

async function candidate(ophis = false): Promise<SelectedBroadcaster> {
  const { CONFIG, FEE_SIGNER, OPHIS_BROADCASTER, TOKENS, WRAPPED_SYMBOL } = await import('./config')
  return { tokenAddress: TOKENS[WRAPPED_SYMBOL].address, railgunAddress: ophis ? OPHIS_BROADCASTER : FEE_SIGNER,
    tokenFee: { expiration: Date.now() + 120_000, feesID: 'native-fee', feePerUnitGas: ophis ? '1' : '10', availableWallets: 1,
      relayAdapt: CONFIG.relayAdaptContract, relayAdapt7702: CONFIG.relayAdapt7702Contract, reliability: 1 } }
}

async function approval(expiresAt = Date.now() + 3_600_000) {
  const { OPHIS_BROADCASTER } = await import('./config')
  return { railgunAddress: OPHIS_BROADCASTER, expiresAt, maxGasPrice: 100_000_000n, maxTransactionCost: 500_000_000_000_000n }
}

it('discovers BNB stablecoin exits through the automatic WBNB fee asset', async () => {
  const { CONFIG, FEE_SIGNER, TOKENS } = await import('./config')
  const fee = await candidate()
  expect(fee.railgunAddress).toBe(FEE_SIGNER)
  mocks.find.mockReturnValue([fee])
  const { selectBroadcaster } = await import('./broadcaster')
  expect(await selectBroadcaster(TOKENS.USDC.address, false, vi.fn())).toBe(fee)
  expect(mocks.find).toHaveBeenCalledWith(CONFIG.chain, TOKENS.WBNB.address, false, false)
})

it.each(['missing', 'expired', 'near-expiry', 'other-chain'])('excludes our cheaper BNB pilot quote with %s approval while retaining other COMMON operators', async (condition) => {
  const pilot = await candidate(true), other = await candidate()
  if (condition === 'expired') mocks.policy[56] = [await approval(Date.now())]
  if (condition === 'near-expiry') mocks.policy[56] = [await approval(Date.now() + 600_000)]
  if (condition === 'other-chain') mocks.policy[1] = [await approval()]
  mocks.find.mockReturnValue([pilot, other])
  const { selectBroadcaster, validateBroadcaster } = await import('./broadcaster')
  expect(await selectBroadcaster(pilot.tokenAddress, false, vi.fn())).toBe(other)
  expect(() => validateBroadcaster(pilot, pilot.tokenAddress, false)).toThrow(/not approved for public submissions/)
  expect(() => validateBroadcaster(other, other.tokenAddress, false)).not.toThrow()
})

it('never selects our unapproved pilot when it is the only COMMON quote', async () => {
  const pilot = await candidate(true)
  mocks.find.mockReturnValue([pilot])
  const { selectBroadcaster } = await import('./broadcaster')
  const pending = selectBroadcaster(pilot.tokenAddress, false, vi.fn())
  const rejected = expect(pending).rejects.toThrow(/No verified compatible broadcaster fee arrived/)
  await vi.advanceTimersByTimeAsync(45_000)
  await rejected
  expect(mocks.create).not.toHaveBeenCalled()
})

it.each(['missing', 'expired'])('rejects direct COMMON validation and submission to our BNB pilot with %s approval before any provider access', async (condition) => {
  const pilot = await candidate(true)
  if (condition === 'expired') mocks.policy[56] = [await approval(Date.now())]
  const { validateBroadcaster, assertSubmittable, submitPrivate } = await import('./broadcaster')
  const read = vi.fn()
  const session = { provider: { send: read, getNetwork: read } } as unknown as WalletSession
  const gas = { evmGasType: EVMGasType.Type0 as const, gasEstimate: 100_000n, gasPrice: 100n }
  expect(() => validateBroadcaster(pilot, pilot.tokenAddress, false)).toThrow(/not approved for public submissions/)
  expect(() => validateBroadcaster({ ...pilot, railgunAddress: pilot.railgunAddress.toUpperCase() }, pilot.tokenAddress, false))
    .toThrow(/not approved for public submissions/)
  await expect(assertSubmittable(session, pilot, gas)).rejects.toThrow(/not approved for public submissions/)
  await expect(submitPrivate(session, { transaction: { to: pilot.tokenAddress, data: '0x' }, nullifiers: ['synthetic-nullifier'],
    preTransactionPOIsPerTxidLeafPerList: {} }, pilot, gas, false))
    .rejects.toThrow(/not approved for public submissions/)
  expect(read).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('preserves COMMON submission through another existing BNB operator without an Ophis approval entry', async () => {
  const other = await candidate()
  const { CONFIG } = await import('./config')
  const { submitPrivate } = await import('./broadcaster')
  const session = { provider: { send: vi.fn().mockResolvedValue(undefined), getNetwork: async () => ({ chainId: 56n }) } } as unknown as WalletSession
  const populated = { transaction: { to: CONFIG.proxyContract,
    data: withdrawalData(1, 1, '0x0000000000000000000000000000000000001234', other.tokenAddress) },
    nullifiers: ['synthetic-nullifier'], preTransactionPOIsPerTxidLeafPerList: {} }
  await expect(submitPrivate(session, populated, other, {
    evmGasType: EVMGasType.Type0, gasEstimate: 100_000n, gasPrice: 100n,
  }, false)).resolves.toBe('synthetic-withdrawal-hash')
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(mocks.send).toHaveBeenCalledOnce()
})

it('permits our reviewed BNB pilot overlay and rechecks its approval before a COMMON send', async () => {
  const pilot = await candidate(true)
  mocks.policy[56] = [await approval()]
  mocks.find.mockReturnValue([pilot])
  const { CONFIG } = await import('./config')
  const { selectBroadcaster, validateBroadcaster, submitPrivate } = await import('./broadcaster')
  expect(await selectBroadcaster(pilot.tokenAddress, true, vi.fn())).toBe(pilot)
  expect(() => validateBroadcaster(pilot, pilot.tokenAddress, false)).not.toThrow()
  const session = { provider: { send: vi.fn().mockResolvedValue(undefined), getNetwork: async () => ({ chainId: 56n }) } } as unknown as WalletSession
  const gas = { evmGasType: EVMGasType.Type0 as const, gasEstimate: 100_000n, gasPrice: 100n }
  const populated = { transaction: { to: CONFIG.proxyContract,
    data: withdrawalData(1, 1, '0x0000000000000000000000000000000000001234', pilot.tokenAddress) },
    nullifiers: ['synthetic-nullifier'], preTransactionPOIsPerTxidLeafPerList: {} }
  await expect(submitPrivate(session, populated, pilot, gas, false)).resolves.toBe('synthetic-withdrawal-hash')
  mocks.send.mockClear()
  mocks.create.mockImplementationOnce(async () => {
    mocks.policy[56][0].expiresAt = Date.now()
    return { send: mocks.send }
  })
  await expect(submitPrivate(session, populated, pilot, gas, false)).rejects.toThrow(/not approved for public submissions/)
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each([42161, 137])('excludes our unapproved identity on chain %i without excluding existing COMMON operators', async (chainId) => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', String(chainId))
  const pilot = await candidate(true), other = await candidate()
  const { validateBroadcaster } = await import('./broadcaster')
  expect(() => validateBroadcaster(pilot, pilot.tokenAddress, false)).toThrow(/not approved for public submissions/)
  expect(() => validateBroadcaster(other, other.tokenAddress, false)).not.toThrow()
})
