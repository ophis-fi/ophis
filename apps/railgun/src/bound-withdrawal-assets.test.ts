import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Interface, Wallet, ZeroAddress, type TransactionReceipt } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Helper, TXIDVersion, type TransactionStructV2 } from '@railgun-community/engine'
import { mixedWithdrawalTransactions, withdrawalData } from '../tests/withdrawal.fixture'
import { EXECUTION_GUARD, executionGuardCode } from '../operator/execution-guard'
import type { WalletSession } from './wallet'
import type { PendingWithdrawal } from './withdrawal-journal'

const state = vi.hoisted(() => ({ pending: undefined as unknown, balances: new Map<string, bigint>(), estimate: vi.fn(),
  remove: vi.fn(), ratchet: vi.fn(), history: vi.fn() }))
vi.mock('@railgun-community/wallet', async (original) => ({ ...await original<typeof import('@railgun-community/wallet')>(),
  fullWalletForID: () => ({ getEphemeralKeyIndex: async () => 0, setEphemeralKeyIndexIfGreater: state.ratchet }),
  balanceForERC20Token: async (_v: unknown, _w: unknown, _n: unknown, address: string) => state.balances.get(address.toLowerCase()) ?? 0n,
  gasEstimateForUnprovenCrossContractCalls7702: state.estimate, getWalletTransactionHistory: state.history }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn(), refreshReceivedBalances: async () => {} }))
vi.mock('./account', () => ({ unusedSwapAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) }))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined }))
vi.mock('./storage', () => ({ readPrivateState: async () => state.pending, writePrivateState: vi.fn(), deletePrivateState: state.remove }))

const recipient = '0x0000000000000000000000000000000000005678'
const customToken = '0x0000000000000000000000000000000000004321'
const hash = `0x${'44'.repeat(32)}`
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '56')
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'fork')
  state.pending = undefined
  state.balances.clear()
  state.estimate.mockReset().mockResolvedValue({ gasEstimate: 3_000_000n })
  state.history.mockReset().mockResolvedValue([])
  state.remove.mockReset().mockResolvedValue(undefined)
  state.ratchet.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

async function setup(chainId = 56) {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', String(chainId))
  const config = await import('./config')
  const token = config.registerToken({ address: customToken, decimals: 8, symbol: 'TEST' })
  state.balances.set(customToken.toLowerCase(), 123_456_789n)
  state.balances.set(config.tokenFor(config.WRAPPED_SYMBOL).address.toLowerCase(), 10n ** 16n)
  const selected = { tokenAddress: config.tokenFor(config.WRAPPED_SYMBOL).address, railgunAddress: config.FEE_SIGNER,
    tokenFee: { expiration: Date.now() + 600_000, feesID: 'generated-fixture', feePerUnitGas: '1150000000000000000',
      availableWallets: 1, reliability: 1, relayAdapt: config.CONFIG.relayAdaptContract, relayAdapt7702: config.CONFIG.relayAdapt7702Contract } }
  const session = { info: { id: 'generated-fixture' }, key: 'test-only',
    accounts: { getCurrentAccount: async () => ({ address: '0x0000000000000000000000000000000000001234' }) },
    provider: { getFeeData: async () => ({ gasPrice: 100n, maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      call: async () => `0x${'19'.padStart(64, '0')}` } } as unknown as WalletSession
  return { config, token, selected, session }
}

it.each([1, 42161, 137, 56])('prepares a registered ERC20 exit on chain %s without reducing principal for its wrapped-native fee', async (chainId) => {
  const { config, token, selected, session } = await setup(chainId)
  const { prepareUnshield } = await import('./unshield')
  const { ADAPT } = await import('./execution')
  const prepared = await prepareUnshield(session, token, '', recipient, selected, true)
  expect(prepared.kind).toBe('TX7702')
  if (prepared.kind !== 'TX7702') throw new Error('Expected bound exit')
  expect(prepared.token).toBe(customToken.toLowerCase())
  expect(prepared.feeToken).toBe(config.WRAPPED_SYMBOL)
  expect(prepared.fee.tokenAddress).toBe(selected.tokenAddress)
  expect(prepared.amounts[0].amount).toBe(123_456_789n)
  expect(prepared.output).toBeUndefined()
  const [transfers] = ADAPT.decodeFunctionData('transfer', prepared.calls[0].data)
  expect(transfers[0].token.tokenAddress.toLowerCase()).toBe(customToken.toLowerCase())
  expect(transfers[0].to).toBe(recipient)
  expect(transfers[0].value).toBe(prepared.minimum)
  expect(state.estimate.mock.calls[0][10].tokenAddress).toBe(selected.tokenAddress)
})

it('reserves the exact fee from a native BNB Max exit and signs exact positive unwrap and output amounts', async () => {
  const { selected, session } = await setup()
  const { prepareUnshield } = await import('./unshield')
  const { ADAPT } = await import('./execution')
  const prepared = await prepareUnshield(session, 'WBNB', '', recipient, selected, true, true)
  if (prepared.kind !== 'TX7702') throw new Error('Expected bound native exit')
  expect(prepared.output).toBe('native')
  expect(prepared.amounts[0].amount + prepared.fee.amount).toBe(10n ** 16n)
  expect(prepared.minimum).toBe(prepared.amounts[0].amount - prepared.amounts[0].amount * 25n / 10_000n)
  expect(prepared.calls).toHaveLength(2)
  expect(ADAPT.decodeFunctionData('unwrapBase', prepared.calls[0].data)[0]).toBe(prepared.minimum)
  const [transfers] = ADAPT.decodeFunctionData('transfer', prepared.calls[1].data)
  expect(transfers[0].token.tokenAddress).toBe(ZeroAddress)
  expect(transfers[0].to).toBe(recipient)
  expect(transfers[0].value).toBe(prepared.minimum)
  expect(prepared.minimum).toBeGreaterThan(0n)
})

it('reports a missing private fee reserve before estimating an arbitrary ERC20 exit', async () => {
  const { config, token, selected, session } = await setup(1)
  state.balances.set(config.tokenFor(config.WRAPPED_SYMBOL).address.toLowerCase(), 0n)
  const { prepareUnshield } = await import('./unshield')
  await expect(prepareUnshield(session, token, '1', recipient, selected)).rejects.toThrow('Insufficient spendable private WETH')
  expect(state.estimate).not.toHaveBeenCalled()
  expect(state.balances.get(customToken.toLowerCase())).toBe(123_456_789n)
})

it.each([1, 56])('rejects native output for an arbitrary ERC20 on chain %s before proving', async (chainId) => {
  const { token, selected, session } = await setup(chainId)
  const { prepareUnshield } = await import('./unshield')
  await expect(prepareUnshield(session, token, '1', recipient, selected, false, true)).rejects.toThrow('Native BNB withdrawal requires private WBNB on BNB Chain')
  expect(state.estimate).not.toHaveBeenCalled()
})

async function signedRecord(native = true, chainId = 56,
  mutate?: (proofs: TransactionStructV2[], calls: { to: string; value: bigint; data: string }[]) => void) {
  const { config, token } = await setup(chainId)
  const { ADAPT, PRIVACY } = await import('./execution')
  const owner = Wallet.createRandom()
  const principal = native ? config.tokenFor(config.WRAPPED_SYMBOL).address : customToken
  const base = mixedWithdrawalTransactions(principal, owner.address)
  const proofs = (native ? [base[1]] : base).map((tx) => ({ ...tx, txidVersion: TXIDVersion.V2_PoseidonMerkle })) as unknown as TransactionStructV2[]
  for (const proof of proofs) { proof.boundParams.adaptContract = owner.address; proof.boundParams.chainID = BigInt(chainId) }
  const transfer = { to: owner.address, value: 0n, data: ADAPT.encodeFunctionData('transfer', [[{
    token: { tokenType: 0, tokenAddress: native ? ZeroAddress : customToken, tokenSubID: 0 }, to: recipient, value: 998n,
  }]]) }
  const calls = native ? [{ to: owner.address, value: 0n, data: ADAPT.encodeFunctionData('unwrapBase', [998n]) }, transfer] : [transfer]
  mutate?.(proofs, calls)
  const action = RelayAdapt7702Helper.getActionData(true, calls, 0n)
  const details = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
  const authorization = await owner.authorize({ address: config.CONFIG.relayAdapt7702Contract, chainId, nonce: 0 })
  const signature = await RelayAdapt7702Helper.signExecutionAuthorization(owner, proofs, action, BigInt(chainId), details)
  const data = RelayAdapt7702Helper.encodeExecute(ADAPT, proofs, action, signature, details)
  const pending: PendingWithdrawal = { chainId, token: native ? config.WRAPPED_SYMBOL : token,
    feeToken: config.WRAPPED_SYMBOL, broadcaster: config.FEE_SIGNER, ...(native ? { output: 'native' as const } : {}),
    recipient, minimum: '998', fromBlock: 100, hash, transaction: { to: owner.address, data, value: '0' },
    nullifiers: proofs.flatMap((proof) => proof.nullifiers.map(String)), minGasPrice: '0',
    execution: { index: 7, account: owner.address, executeNonce: '0', gasEstimate: '3000000', maxFeePerGas: '100', maxPriorityFeePerGas: '10',
      authorization: { address: authorization.address, chainId: String(chainId), nonce: '0', signature: authorization.signature.serialized } } }
  const wrapper = new Interface(['event Withdrawal(address indexed src,uint256 wad)'])
  const receipt = { status: 1, blockNumber: 102, confirmations: async () => 2, logs: [
    { address: config.CONFIG.proxyContract, ...PRIVACY.encodeEventLog('Nullified', [0, pending.nullifiers]) },
    { address: config.CONFIG.proxyContract, ...PRIVACY.encodeEventLog('Unshield', [owner.address, { tokenType: 0, tokenAddress: principal, tokenSubID: 0 }, 998n, 2n]) },
    ...(native ? [
      { address: principal, ...wrapper.encodeEventLog('Withdrawal', [owner.address, 998n]) },
      { address: config.CONFIG.proxyContract, ...PRIVACY.encodeEventLog('Transact', [0, 0, [proofs[0].commitments[0]], [proofs[0].boundParams.commitmentCiphertext[0]]]) },
    ] : [{ address: principal, ...new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']).encodeEventLog('Transfer', [owner.address, recipient, 998n]) }]),
  ] } as unknown as TransactionReceipt
  const delegateCode = '0x6001600055'
  const provider = { getNetwork: vi.fn(async () => ({ chainId: BigInt(chainId) })),
    getTransaction: vi.fn(async () => ({ hash, to: owner.address, from: recipient, data, value: 0n, blockNumber: 102 })),
    getCode: vi.fn(async (address: string) => address.toLowerCase() === owner.address.toLowerCase()
      ? `0xef0100${config.CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}` : delegateCode),
    call: vi.fn(async (_tx: { to?: string }) => ADAPT.encodeFunctionResult('nonce', [1n])),
    getTransactionReceipt: vi.fn(async () => receipt), getBlockNumber: vi.fn(async () => 103),
  }
  const session = { info: { id: 'generated-fixture' }, provider } as unknown as WalletSession
  state.pending = pending
  return { config, owner, pending, receipt, session, provider, delegateCode }
}

it.each([1, 42161, 137, 56])('validates real execution signatures binding both arbitrary ERC20 proofs on chain %s', async (chainId) => {
  const { owner, pending } = await signedRecord(false, chainId)
  const { assertBoundWithdrawal } = await import('./execution')
  expect(() => assertBoundWithdrawal(pending.transaction.data, owner.address, pending.token, recipient, 998n)).not.toThrow()
  const { pendingWithdrawal, savedWithdrawalSummary } = await import('./withdrawal-journal')
  await expect(pendingWithdrawal({} as WalletSession)).resolves.toEqual(pending)
  expect(savedWithdrawalSummary(pending)).toContain('TEST')
  expect(savedWithdrawalSummary(pending)).toContain(customToken)
  const { assertAtomicWithdrawal } = await import('./execution')
  expect(() => assertAtomicWithdrawal(withdrawalData(1, 1, recipient, customToken), pending.feeToken)).toThrow(/signed private execution/)
})

it('checks native canonical logs without inventing a native recipient Transfer event', async () => {
  const { pending, receipt } = await signedRecord()
  const { assertWithdrawalReceipt } = await import('./withdrawal-journal')
  expect(() => assertWithdrawalReceipt(receipt, pending)).not.toThrow()
  for (const index of [1, 2, 3]) {
    const missing = { ...receipt, logs: receipt.logs.filter((_log, i) => i !== index) } as unknown as TransactionReceipt
    expect(() => assertWithdrawalReceipt(missing, pending)).toThrow(/not confirmed/)
  }
  const changed = { ...receipt, logs: receipt.logs.map((log, i) => i !== 2 ? log : { ...log,
    ...new Interface(['event Withdrawal(address indexed src,uint256 wad)']).encodeEventLog('Withdrawal', [recipient, 998n]) }) } as unknown as TransactionReceipt
  expect(() => assertWithdrawalReceipt(changed, pending)).toThrow(/not confirmed/)
})

it('requires the exact signed unwrap and native transfer amounts even when a changed action is authentically signed', async () => {
  const { ADAPT, assertBoundWithdrawal } = await import('./execution')
  for (const change of [
    (_proofs: TransactionStructV2[], calls: { data: string }[]) => { calls[0].data = ADAPT.encodeFunctionData('unwrapBase', [0n]) },
    (_proofs: TransactionStructV2[], calls: { data: string }[]) => { calls[0].data = ADAPT.encodeFunctionData('unwrapBase', [997n]) },
    (_proofs: TransactionStructV2[], calls: { data: string }[]) => { calls.reverse() },
    (_proofs: TransactionStructV2[], calls: { data: string }[]) => { calls[1].data = ADAPT.encodeFunctionData('transfer', [[{ token: { tokenType: 0, tokenAddress: ZeroAddress, tokenSubID: 0 }, to: recipient, value: 0n }]]) },
    (proofs: TransactionStructV2[]) => { proofs[0].boundParams.adaptContract = ZeroAddress },
    (proofs: TransactionStructV2[]) => { proofs[0].boundParams.adaptParams = `0x${'11'.repeat(32)}` },
    (proofs: TransactionStructV2[]) => { proofs[0].boundParams.chainID = 1n },
    (proofs: TransactionStructV2[]) => { proofs[0].boundParams.minGasPrice = 1n },
    (proofs: TransactionStructV2[]) => { proofs.push(proofs[0]) },
    (_proofs: TransactionStructV2[], calls: { to: string }[]) => { calls[1].to = recipient },
    (_proofs: TransactionStructV2[], calls: { value: bigint }[]) => { calls[1].value = 1n },
    (proofs: TransactionStructV2[]) => { proofs[0].unshieldPreimage.token.tokenAddress = customToken },
  ]) {
    const { pending, owner } = await signedRecord(true, 56, change)
    expect(() => assertBoundWithdrawal(pending.transaction.data, owner.address, pending.token, recipient, 998n, 'native')).toThrow()
  }
})

it.each([false, true])('confirms native output only after matching its direct or canonical guarded execution (guarded: %s)', async (guarded) => {
  const { config, owner, pending, receipt, session, provider, delegateCode } = await signedRecord()
  const { assertNativeExecutionBinding } = await import('./execution')
  if (guarded) {
    const guard = '0x0000000000000000000000000000000000007890'
    const code = executionGuardCode(recipient, delegateCode, config.CONFIG.relayAdapt7702Contract)
    provider.getTransaction.mockResolvedValue({ hash, to: guard, from: recipient, data: EXECUTION_GUARD.encodeFunctionData('execute', [owner.address, pending.transaction.data, 0n]), value: 0n, blockNumber: 102 })
    provider.getCode.mockImplementation(async (address: string) => address === guard ? code
      : address.toLowerCase() === owner.address.toLowerCase() ? `0xef0100${config.CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}` : delegateCode)
  }
  await expect(assertNativeExecutionBinding(session, receipt, pending, hash)).resolves.toBeUndefined()
  const { reconcilePendingWithdrawal } = await import('./withdrawal-journal')
  await expect(reconcilePendingWithdrawal(session)).resolves.toContain('Withdrawal confirmed')
  expect(state.ratchet).toHaveBeenCalledWith(56n, 8)
  expect(state.ratchet.mock.invocationCallOrder[0]).toBeLessThan(state.remove.mock.invocationCallOrder[0])
})

it.each(['calldata', 'nonce', 'delegate', 'chain', 'guard'])('preserves the complete native proof when actual execution %s does not match', async (changed) => {
  const { pending, receipt, session, provider, config, delegateCode } = await signedRecord()
  const { ADAPT, assertNativeExecutionBinding } = await import('./execution')
  if (changed === 'calldata') provider.getTransaction.mockResolvedValue({ hash, to: pending.execution!.account, from: recipient, data: '0x1234', value: 0n, blockNumber: 102 })
  if (changed === 'nonce') provider.call.mockResolvedValue(ADAPT.encodeFunctionResult('nonce', [0n]))
  if (changed === 'delegate') provider.getCode.mockResolvedValue(delegateCode)
  if (changed === 'chain') provider.getNetwork.mockResolvedValue({ chainId: 1n })
  if (changed === 'guard') provider.getTransaction.mockResolvedValue({ hash, to: recipient, from: recipient,
    data: EXECUTION_GUARD.encodeFunctionData('execute', [pending.execution!.account, pending.transaction.data, 0n]), value: 0n, blockNumber: 102 })
  await expect(assertNativeExecutionBinding(session, receipt, pending, hash)).rejects.toThrow()
  // All inputs are reported spent, as they are after a mined success. This must
  // preserve a bound record without an authenticated complete native receipt.
  provider.call.mockImplementation(async (tx: { to?: string }) => tx.to?.toLowerCase() === config.CONFIG.proxyContract.toLowerCase()
    ? `0x${'1'.padStart(64, '0')}` : ADAPT.encodeFunctionResult('nonce', [0n]))
  const { reconcilePendingWithdrawal } = await import('./withdrawal-journal')
  await expect(reconcilePendingWithdrawal(session)).rejects.toThrow('complete saved proof is preserved')
  expect(state.pending).toBe(pending)
  expect(state.ratchet).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
})
