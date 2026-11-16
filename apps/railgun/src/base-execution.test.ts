import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JsonRpcProvider, Wallet } from 'ethers'
import { RelayAdapt7702ExecutionType, type RelayAdapt7702Request } from '@railgun-community/engine'
import type { WalletSession } from './wallet'

const mocks = vi.hoisted(() => ({ prepared: vi.fn(), saved: vi.fn(), require: vi.fn(), used: vi.fn(), reserved: vi.fn() }))
vi.mock('@railgun-community/wallet', () => ({ fullWalletForID: () => ({ getEphemeralKeyIndex: async () => 4 }) }))
vi.mock('./base-setup', () => ({ baseAccountPrepared: mocks.prepared, savedBaseExecutionSetup: mocks.saved,
  requireBaseExecutionSetup: mocks.require, markBaseExecutionSetupUsed: mocks.used, isBaseSetupAccountReserved: mocks.reserved }))
beforeEach(() => { vi.resetModules(); vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '8453'); vi.resetAllMocks() })
afterEach(() => vi.unstubAllEnvs())

it('sends Base signed execution calldata as type2 with no new authorization and rejects payload substitution', async () => {
  const { encodeRequest, assertSameExecution } = await import('./execution'), { CONFIG } = await import('./config')
  const account = Wallet.createRandom(), provider = new JsonRpcProvider('http://127.0.0.1:1')
  try {
    const request: RelayAdapt7702Request = { transactions: [], actionData: { requireSuccess: true, calls: [], minGasLimit: 0n },
      authorization: await account.authorize({ chainId: 8453n, address: CONFIG.relayAdapt7702Contract, nonce: 1 }),
      ephemeralAddress: account.address, executionSignature: '0x', executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
    const transaction = encodeRequest(request), session = { provider } as WalletSession
    expect(transaction.type).toBe(2); expect(transaction.authorizationList).toBeUndefined()
    expect(() => assertSameExecution(session, request, transaction)).not.toThrow()
    for (const changed of [{ ...transaction, data: '0x' }, { ...transaction, type: 4 },
      { ...transaction, authorizationList: [request.authorization] }, { ...transaction, value: 1n }])
      expect(() => assertSameExecution(session, request, changed)).toThrow()
  } finally { provider.destroy() }
})

it.each([true, false])('keeps only an unused prepared Base account, prepared=%s', async ready => {
  const { unusedSwapAccount } = await import('./account')
  mocks.prepared.mockResolvedValue(ready)
  mocks.saved.mockResolvedValue({ account: 'prepared', confirmed: true, ...(ready ? {} : { used: true }) })
  const next = vi.fn(async () => ({ address: 'next' })), session = { accounts: {
    scanHistoryForEphemeralIndex: async () => {}, getCurrentAccount: async () => ({ address: 'prepared' }), getNextAccount: next,
  }, provider: { getTransactionCount: async (address: string) => address === 'prepared' ? 1 : 0 } } as unknown as WalletSession
  expect((await unusedSwapAccount(session)).address).toBe(ready ? 'prepared' : 'next')
  expect(next).toHaveBeenCalledTimes(ready ? 0 : 1)
})

it('does not skip a paid setup while its confirmation or history check is pending', async () => {
  const { unusedSwapAccount } = await import('./account')
  mocks.saved.mockResolvedValue({ account: 'prepared' })
  const next = vi.fn(async () => ({ address: 'next' })), session = { accounts: {
    scanHistoryForEphemeralIndex: async () => {}, getCurrentAccount: async () => ({ address: 'prepared' }), getNextAccount: next,
  }, provider: { getTransactionCount: async () => 1 } } as unknown as WalletSession
  await expect(unusedSwapAccount(session)).rejects.toThrow('saved Base account setup')
  expect(next).not.toHaveBeenCalled()
  mocks.saved.mockResolvedValue({ account: 'prepared', confirmed: true }); mocks.prepared.mockResolvedValue(false)
  await expect(unusedSwapAccount(session)).rejects.toThrow('setup changed')
  expect(next).not.toHaveBeenCalled()
})

it('skips a cancelled legacy account even if its disclosed authorization has not been applied', async () => {
  const { unusedSwapAccount } = await import('./account')
  mocks.saved.mockResolvedValue({ version: 1, account: 'cancelled', cancelled: true })
  mocks.reserved.mockImplementation(async (_session, address) => address === 'cancelled')
  const next = vi.fn(async () => ({ address: 'fresh' })), session = { accounts: {
    scanHistoryForEphemeralIndex: async () => {}, getCurrentAccount: async () => ({ address: 'cancelled' }), getNextAccount: next,
  }, provider: { getTransactionCount: async () => 0 } } as unknown as WalletSession
  expect((await unusedSwapAccount(session)).address).toBe('fresh')
  expect(next).toHaveBeenCalledOnce()
})

it.each(['WETH', 'USDC', 'USDT'])('uses the guarded predelegated path for Base %s withdrawals', async token => {
  const { usesBoundWithdrawal } = await import('./fee-asset')
  expect(usesBoundWithdrawal(token as 'WETH')).toBe(true)
})

it.each(['pending', 'confirmed', 'used-reorg'])('native shielding preserves the %s paid setup and selects a separate fresh account', async state => {
  const { unusedNativeShieldAccount } = await import('./account')
  mocks.saved.mockResolvedValue({ index: 4, account: 'prepared', ...(state === 'pending' ? {} : { confirmed: true }),
    ...(state === 'used-reorg' ? { used: true } : {}) })
  const next = vi.fn(), getAccount = vi.fn(async (_chain: bigint, index: number) => ({ address: `account${index}` }))
  const session = { info: { id: 'test' }, accounts: { scanHistoryForEphemeralIndex: async () => {}, getAccount, getNextAccount: next },
    provider: { getTransactionCount: async (account: string) => account === 'account5' ? 1 : 0,
      getCode: async () => '0x' } } as unknown as WalletSession
  expect((await unusedNativeShieldAccount(session)).address).toBe('account6')
  expect(getAccount.mock.calls.map(([, index]) => index)).toEqual([5, 6])
  expect(next).not.toHaveBeenCalled()
})

it('the installed SDK history scan does not skip a prepared account after a native shield on a later account', async () => {
  const { EphemeralKeyManager } = await vi.importActual<typeof import('@railgun-community/wallet')>('@railgun-community/wallet')
  const address = (index: number) => `0x${(1000 + index).toString(16).padStart(40, '0')}`
  let current = 4
  const wallet = {
    getTransactionHistory: async () => [
      { unshieldTokenAmounts: [{ recipientAddress: address(3) }] },
      { unshieldTokenAmounts: [], receiveTokenAmounts: [{ recipientAddress: address(5) }] },
    ],
    getEphemeralWallet: async (_key: string, _chain: bigint, index: number) => ({ address: address(index) }),
    getEphemeralKeyIndex: async () => current,
    setEphemeralKeyIndexIfGreater: async (_chain: bigint, index: number) => { current = Math.max(current, index); return current },
  }
  const accounts = new EphemeralKeyManager(wallet as never, 'synthetic-test-key')
  await accounts.scanHistoryForEphemeralIndex({ type: 0, id: 8453 })
  expect(current).toBe(4)
  expect((await accounts.getCurrentAccount(8453n)).address).toBe(address(4))
})

it('persists the consumed-account marker before disclosing a signed Base execution to simulation', async () => {
  const { ADAPT, simulateRequest } = await import('./execution'), { CONFIG } = await import('./config')
  const { Interface } = await import('ethers')
  const registry = new Interface(['function getContractAddress(string) view returns (address)'])
  const account = Wallet.createRandom(), provider = new JsonRpcProvider('http://127.0.0.1:1')
  try {
    vi.spyOn(provider, 'getNetwork').mockResolvedValue({ chainId: 8453n } as any)
    vi.spyOn(provider, 'call').mockImplementation(async tx => tx.to === CONFIG.railgunRegistryContract
      ? registry.encodeFunctionResult('getContractAddress', [CONFIG.relayAdapt7702Contract])
      : ADAPT.encodeFunctionResult('adaptImplementation', [CONFIG.relayAdapt7702Contract]))
    const send = vi.spyOn(provider, 'send').mockImplementation(async () => {
      expect(mocks.used).toHaveBeenCalledWith(expect.anything(), account.address)
      throw new Error('trace unavailable')
    })
    const request: RelayAdapt7702Request = { transactions: [], actionData: { requireSuccess: true, calls: [], minGasLimit: 0n },
      authorization: await account.authorize({ chainId: 8453n, address: CONFIG.relayAdapt7702Contract, nonce: 1 }),
      ephemeralAddress: account.address, executionSignature: '0x', executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
    mocks.used.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(simulateRequest({ provider } as WalletSession, request, 100_000n)).rejects.toThrow('storage unavailable')
    expect(send).not.toHaveBeenCalled()
    await expect(simulateRequest({ provider } as WalletSession, request, 100_000n)).rejects.toThrow('trace unavailable')
    expect(send).toHaveBeenCalledOnce()
  } finally { provider.destroy() }
})
