import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseUnits, Wallet } from 'ethers'
import { RelayAdapt7702Helper, RelayAdapt7702ExecutionType, TXIDVersion, type TransactionStructV2 } from '@railgun-community/engine'
import type { WalletSession } from './wallet'
import { mixedWithdrawalData, mixedWithdrawalTransactions, withdrawalData } from '../tests/withdrawal.fixture'

const state = vi.hoisted(() => ({ balances: new Map<string, bigint>(), balance: vi.fn(), estimate: vi.fn(),
  withdrawalEstimate: vi.fn(), quote: vi.fn(), select: vi.fn(), save: vi.fn(), prove: vi.fn(), simulate: vi.fn(), pending: undefined as unknown }))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...await original<typeof import('@railgun-community/wallet')>(),
  fullWalletForID: () => ({ getEphemeralKeyIndex: async () => 0 }), balanceForERC20Token: state.balance,
  gasEstimateForUnprovenCrossContractCalls7702: state.estimate,
  gasEstimateForUnprovenUnshield: state.withdrawalEstimate, generateUnshieldProof: state.prove,
}))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn(), refreshReceivedBalances: async () => {} }))
vi.mock('./storage', () => ({ readPrivateState: vi.fn(), writePrivateState: vi.fn(), deletePrivateState: vi.fn() }))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined }))
vi.mock('./withdrawal-journal', async (original) => ({ ...await original<typeof import('./withdrawal-journal')>(),
  pendingWithdrawal: async () => state.pending, withdrawalInputsSpent: async () => false, savePendingWithdrawal: state.save }))
vi.mock('./recipe', async (original) => ({ ...await original<typeof import('./recipe')>(), assertQuoteFresh: vi.fn(), quoteSwap: state.quote }))
vi.mock('./account', () => ({ unusedSwapAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) }))
vi.mock('./execution', async (original) => ({ ...await original<typeof import('./execution')>(), simulateRequest: state.simulate }))
vi.mock('./broadcaster', async (original) => ({ ...await original<typeof import('./broadcaster')>(), selectBroadcaster: state.select }))

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '56')
  state.pending = undefined
  for (const mock of [state.balance, state.estimate, state.withdrawalEstimate, state.quote, state.select, state.save, state.prove]) mock.mockReset()
  const { TOKENS } = await import('./config')
  state.balances = new Map([[TOKENS.USDC.address.toLowerCase(), 10n ** 19n], [TOKENS.USDT.address.toLowerCase(), 10n ** 19n], [TOKENS.WBNB.address.toLowerCase(), 10n ** 16n]])
  state.balance.mockImplementation(async (_v, _w, _n, token) => state.balances.get(String(token).toLowerCase()) ?? 0n)
  state.estimate.mockResolvedValue({ gasEstimate: 3_000_000n })
  state.withdrawalEstimate.mockResolvedValue({ gasEstimate: 1_500_000n })
  state.quote.mockImplementation(async (_provider, sell, amount, account, buy) => ({ sell, buy, amount: parseUnits(amount, 18), account, calls: [] }))
})
afterEach(() => vi.unstubAllEnvs())

const session = { info: { id: 'generated-test-wallet' }, key: 'test-only',
  accounts: { getCurrentAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) },
  provider: { getFeeData: async () => ({ gasPrice: 100n }), getNetwork: async () => ({ chainId: 56n }),
    getBlock: async () => ({ baseFeePerGas: 0n }), waitForTransaction: async () => undefined,
    call: async () => `0x${'19'.padStart(64, '0')}` } } as unknown as WalletSession

async function selected() {
  const { CONFIG, FEE_SIGNER, TOKENS } = await import('./config')
  return { tokenAddress: TOKENS.WBNB.address, railgunAddress: FEE_SIGNER,
    tokenFee: { expiration: Date.now() + 600_000, feesID: 'test-only', feePerUnitGas: '1150000000000000000',
      availableWallets: 1, reliability: 1, relayAdapt: CONFIG.relayAdaptContract, relayAdapt7702: CONFIG.relayAdapt7702Contract } }
}

it.each(['USDC', 'USDT'] as const)('preserves the full %s Max swap principal and pays fees from WBNB', async (token) => {
  const { prepareMaxPrivateSwap } = await import('./private-swap')
  const { TOKENS } = await import('./config')
  const prepared = await prepareMaxPrivateSwap(session, token, await selected(), undefined, 'WBNB')
  expect(prepared.quote.amount).toBe(10n ** 19n)
  expect(prepared.feeToken).toBe('WBNB')
  expect(prepared.fee.tokenAddress).toBe(TOKENS.WBNB.address)
  expect(state.quote).toHaveBeenCalledOnce()
  expect(state.estimate.mock.calls[0][10].tokenAddress).toBe(TOKENS.WBNB.address)
})

it('reports missing private WBNB without reducing stablecoin principal or estimating a proof', async () => {
  const { TOKENS } = await import('./config')
  state.balances.set(TOKENS.WBNB.address.toLowerCase(), 0n)
  const { prepareMaxPrivateSwap } = await import('./private-swap')
  await expect(prepareMaxPrivateSwap(session, 'USDC', await selected(), undefined, 'WBNB')).rejects.toThrow('Insufficient spendable private WBNB')
  expect(state.quote).toHaveBeenCalledOnce()
  expect(state.estimate).not.toHaveBeenCalled()
})

it('still reserves fees from WBNB principal when Max sells the fee asset itself', async () => {
  const { prepareMaxPrivateSwap } = await import('./private-swap')
  const prepared = await prepareMaxPrivateSwap(session, 'WBNB', await selected(), undefined, 'USDC')
  expect(prepared.quote.amount).toBeLessThan(10n ** 16n)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(10n ** 16n)
})

it('rejects stablecoin-denominated quotes rather than silently changing their fee asset', async () => {
  const { TOKENS } = await import('./config')
  const { validateBroadcaster } = await import('./broadcaster')
  const quote = { ...await selected(), tokenAddress: TOKENS.USDC.address }
  expect(() => validateBroadcaster(quote, TOKENS.USDC.address, false)).toThrow('Invalid broadcaster quote')
})

it.each(['USDC', 'USDT'] as const)('withdraws the full %s Max balance while reserving a separate private WBNB fee', async (token) => {
  const { prepareUnshield } = await import('./unshield')
  const prepared = await prepareUnshield(session, token, '', '0x0000000000000000000000000000000000005678', await selected(), true)
  expect(prepared.amounts[0].amount).toBe(10n ** 19n)
  expect(prepared.feeToken).toBe('WBNB')
  expect(prepared.minimum).toBeGreaterThan(0n)
  expect(prepared.kind).toBe('TX7702')
  expect(state.estimate).toHaveBeenCalledOnce()
})

it('does not spend stablecoins to compensate for a missing withdrawal fee reserve', async () => {
  const { TOKENS } = await import('./config')
  state.balances.set(TOKENS.WBNB.address.toLowerCase(), 0n)
  const { prepareUnshield } = await import('./unshield')
  await expect(prepareUnshield(session, 'USDC', '1', '0x0000000000000000000000000000000000005678', await selected()))
    .rejects.toThrow('Add BNB or WBNB to your private wallet for fees')
  expect(state.withdrawalEstimate).not.toHaveBeenCalled()
})

it('rejects every unbound mixed COMMON batch while preserving its actual stablecoin summary', async () => {
  const { TOKENS } = await import('./config')
  const { assertAtomicWithdrawal, PRIVACY } = await import('./execution')
  const { savedWithdrawalSummary } = await import('./withdrawal-journal')
  const recipient = '0x0000000000000000000000000000000000005678'
  const data = mixedWithdrawalData(TOKENS.USDC.address, recipient)
  expect(() => assertAtomicWithdrawal(data, 'WBNB')).toThrow(/signed private execution/)
  expect(savedWithdrawalSummary({ token: 'USDC', feeToken: 'WBNB', recipient, transaction: { data } } as never)).toContain('USDC')
  const decode = () => mixedWithdrawalTransactions(TOKENS.USDC.address, recipient)
  const txs = decode()
  expect(() => assertAtomicWithdrawal(PRIVACY.encodeFunctionData('transact', [[txs[1], txs[0]]]), 'WBNB')).toThrow()
  for (const mutate of [
    (tx: typeof txs) => { tx[1].nullifiers = tx[0].nullifiers },
    (tx: typeof txs) => { tx[0].boundParams.adaptContract = recipient },
    (tx: typeof txs) => { tx[0].unshieldPreimage.value = 1n },
    (tx: typeof txs) => { tx[1].unshieldPreimage.token.tokenAddress = TOKENS.WBNB.address },
  ]) {
    const changed = decode()
    mutate(changed)
    expect(() => assertAtomicWithdrawal(PRIVACY.encodeFunctionData('transact', [changed]), 'WBNB')).toThrow()
  }
  expect(() => assertAtomicWithdrawal(withdrawalData(1, 1, recipient, TOKENS.USDC.address), 'WBNB')).toThrow(/signed private execution/)
  expect(() => assertAtomicWithdrawal(withdrawalData(1, 1, recipient, TOKENS.USDC.address))).not.toThrow() // exact legacy proof remains recoverable
})

it('preserves unsafe legacy mixed proof bytes and never retries them through a broadcaster', async () => {
  const { CONFIG, TOKENS } = await import('./config')
  const { retrySavedUnshield } = await import('./unshield')
  const recipient = '0x0000000000000000000000000000000000005678'
  const transaction = { to: CONFIG.proxyContract, data: mixedWithdrawalData(TOKENS.USDC.address, recipient), value: '0' }
  const saved = { token: 'USDC', feeToken: 'WBNB', broadcaster: (await selected()).railgunAddress, transaction, minGasPrice: '100', nullifiers: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] }
  state.pending = saved
  state.select.mockResolvedValue(await selected())
  const send = vi.fn().mockResolvedValue(`0x${'44'.repeat(32)}`)
  await expect(retrySavedUnshield(session, () => {}, { assertReady: vi.fn(), send })).rejects.toThrow(/signed private execution/)
  expect(send).not.toHaveBeenCalled();expect(state.select).not.toHaveBeenCalled()
  expect(saved.transaction.data).toBe(transaction.data)
  expect(state.prove).not.toHaveBeenCalled()
  state.pending = { ...saved, feeToken: undefined }
  send.mockClear(); state.select.mockClear()
  await expect(retrySavedUnshield(session, () => {}, { assertReady: vi.fn(), send })).rejects.toThrow('retired broadcaster fee token')
  expect(send).not.toHaveBeenCalled();expect(state.select).not.toHaveBeenCalled();expect(state.prove).not.toHaveBeenCalled()
})

it.each([false, true])('retries exactly the signed strict withdrawal through its original fee recipient without re-proving (native: %s)', async (native) => {
  const { CONFIG, TOKENS } = await import('./config')
  const { ADAPT, assertBoundWithdrawal } = await import('./execution')
  const { retrySavedUnshield } = await import('./unshield')
  const owner = Wallet.createRandom()
  const recipient = '0x0000000000000000000000000000000000005678'
  const token = native ? 'WBNB' : 'USDC'
  const mixed = mixedWithdrawalTransactions(TOKENS[token].address, recipient)
  const proofs = (native ? [mixed[1]] : mixed).map((tx) => ({ ...tx, txidVersion: TXIDVersion.V2_PoseidonMerkle })) as unknown as TransactionStructV2[]
  for (const proof of proofs) proof.boundParams.adaptContract = owner.address
  proofs[proofs.length - 1].unshieldPreimage.npk = `0x${owner.address.slice(2).padStart(64, '0')}`
  const transfer = { to: owner.address, value: 0n, data: ADAPT.encodeFunctionData('transfer', [[{
    token: { tokenType: 0, tokenAddress: native ? '0x0000000000000000000000000000000000000000' : TOKENS.USDC.address, tokenSubID: 0 }, to: recipient, value: 998n,
  }]]) }
  const calls = native ? [{ to: owner.address, value: 0n, data: ADAPT.encodeFunctionData('unwrapBase', [998n]) }, transfer] : [transfer]
  const actionData = RelayAdapt7702Helper.getActionData(true, calls, 0n)
  const details = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
  const authorization = await owner.authorize({ address: CONFIG.relayAdapt7702Contract, chainId: 56, nonce: 0 })
  const signature = await RelayAdapt7702Helper.signExecutionAuthorization(owner, proofs, actionData, 56n, details)
  const data = RelayAdapt7702Helper.encodeExecute(ADAPT, proofs, actionData, signature, details)
  expect(() => assertBoundWithdrawal(data, owner.address, token, recipient, 998n, native ? 'native' : undefined)).not.toThrow()
  const broadcaster = await selected()
  state.pending = { token, feeToken: 'WBNB', broadcaster: broadcaster.railgunAddress, recipient, minimum: '998', ...(native ? { output: 'native' } : {}),
    nullifiers: proofs.flatMap((proof) => proof.nullifiers), minGasPrice: '0', transaction: { to: owner.address, data, value: '0' },
    execution: { account: owner.address, index: 0, executeNonce: '0', authorization: { address: authorization.address,
      chainId: '56', nonce: '0', signature: authorization.signature.serialized }, gasEstimate: '3000000', maxFeePerGas: '100', maxPriorityFeePerGas: '100' } }
  state.select.mockResolvedValue(broadcaster)
  const send = vi.fn().mockResolvedValue(`0x${'44'.repeat(32)}`)
  await expect(retrySavedUnshield(session, () => {}, { assertReady: vi.fn(), send })).rejects.toThrow('Withdrawal unconfirmed')
  expect(state.select).toHaveBeenCalledWith(TOKENS.WBNB.address, true, expect.any(Function), broadcaster.railgunAddress)
  expect(send.mock.calls[0][1].transaction.data).toBe(data)
  expect(send.mock.calls[0][1].transaction.authorizationList[0].signature.serialized).toBe(authorization.signature.serialized)
  expect(send.mock.calls[0][1].transaction.maxFeePerGas).toBe(100n)
  expect(send.mock.calls[0][1].transaction.maxPriorityFeePerGas).toBe(100n)
  expect(state.save.mock.calls[0][1].output).toBe(native ? 'native' : undefined)
  expect(state.prove).not.toHaveBeenCalled()
})
