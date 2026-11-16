import { beforeEach, expect, it, vi } from 'vitest'
import { CONFIG } from './config'
import { Transaction, verifyAuthorization, Wallet } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Validator } from '@railgun-community/engine'
import { ADAPT } from './execution'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({
  nonce: vi.fn(), remove: vi.fn(), ratchet: vi.fn(), confirmedNonce: 0n, confirmedCode: '', chainId: 1, reorg: false,
  balance: vi.fn(), estimate: vi.fn(), send: vi.fn(), rpc: vi.fn(), wait: vi.fn(), priceCap: undefined as bigint | undefined,
  currentCode: '', currentNonce: 1n, maxFee: 2_000_000_000n, priority: 1_000_000_000n,
  derive: vi.fn(), payerSend: vi.fn(), payerCode: '', payerNonce: 2, payerLatestNonce: 2, targetNonce: 0, outerRaw: '',
}))
vi.mock('./config', async original => ({ ...(await original<typeof import('./config')>()), get CHAIN_ID() { return state.chainId },
  get CHAIN() { return BigInt(state.chainId) }, get PREPAID_BROADCASTERS() {
    return state.priceCap === undefined ? {} : { [state.chainId]: { maxGasPrice: state.priceCap } }
  } }))
const delegation = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`
const wallet = new Wallet(`0x${'11'.repeat(32)}`), account = wallet.address
const payerWallet = new Wallet(`0x${'22'.repeat(32)}`), payerAddress = payerWallet.address
vi.mock('ethers', async (original) => ({
  ...(await original<typeof import('ethers')>()),
  Contract: class { getFunction = () => state.nonce },
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  fullWalletForID: () => ({ setEphemeralKeyIndexIfGreater: state.ratchet }),
}))
vi.mock('./storage', () => ({
  readPrivateState: async () => ({ chainId: state.chainId, index: 3, account, token: 'WETH', minimum: '1',
    npk: `0x${'11'.repeat(32)}`, executeNonce: '0', fromBlock: 90 }),
  deletePrivateState: state.remove,
}))
import { CANCELLATION_GAS_LIMIT, cancelPendingSwap } from './cancel'

const session = {
  info: { id: 'test' },
  provider: {
    getNetwork: async () => ({ chainId: BigInt(state.chainId) }),
    getBlock: async (tag: string | number) => ({ number: tag === 'latest' ? 101 : typeof tag === 'number' ? tag : 100,
      hash: `0x${(state.reorg && typeof tag === 'number' ? '22' : '11').repeat(32)}`, parentHash: `0x${'11'.repeat(32)}` }),
    getCode: async (address: string, block?: number) => address === payerAddress ? state.payerCode : block === 100 ? state.confirmedCode : state.currentCode,
    getBalance: state.balance, estimateGas: state.estimate,
    getTransactionCount: async (address: string, tag: string) => address === payerAddress
      ? tag === 'latest' ? state.payerLatestNonce : state.payerNonce : state.targetNonce,
    getFeeData: async () => ({ maxFeePerGas: state.maxFee, maxPriorityFeePerGas: state.priority }),
    send: state.rpc,
  },
  accounts: { getAccount: state.derive },
} as unknown as WalletSession

beforeEach(() => {
  vi.clearAllMocks()
  state.chainId = 1; state.reorg = false
  state.currentCode = delegation; state.currentNonce = 1n; state.priceCap = undefined
  state.payerCode = delegation; state.payerNonce = 2; state.payerLatestNonce = 2; state.targetNonce = 0; state.outerRaw = ''
  state.maxFee = 2_000_000_000n; state.priority = 1_000_000_000n
  state.balance.mockReset().mockResolvedValue(10n ** 16n)
  state.estimate.mockReset().mockResolvedValue(106_531n)
  state.wait.mockReset().mockResolvedValue({ status: 1 })
  state.send.mockReset().mockResolvedValue({ wait: state.wait })
  state.payerSend.mockReset().mockImplementation(async transaction => {
    state.outerRaw = await payerWallet.signTransaction(transaction)
    return { wait: state.wait }
  })
  state.derive.mockReset().mockImplementation(async (_chain, index) => {
    const selected = index === 3 ? wallet : payerWallet, send = index === 3 ? state.send : state.payerSend
    return { address: selected.address, signer: { address: selected.address,
      populateAuthorization: selected.populateAuthorization.bind(selected), authorize: selected.authorize.bind(selected),
      signTypedData: selected.signTypedData.bind(selected), connect: () => ({ sendTransaction: send }) } }
  })
  state.confirmedCode = delegation
  state.confirmedNonce = 0n
  state.nonce.mockImplementation(async (options?: { blockTag: unknown }) =>
    options?.blockTag !== undefined ? state.confirmedNonce : state.currentNonce)
  state.rpc.mockReset().mockImplementation(async (method: string, params: unknown[]) => {
    if (method === 'eth_blockNumber') return '0x65'
    if (method === 'eth_getBlockByNumber') {
      const block = await session.provider.getBlock(params[0] === 'finalized' ? 'finalized' : Number(BigInt(String(params[0]))))
      return { ...block, number: `0x${block!.number.toString(16)}` }
    }
    expect(params[1]).toEqual({ blockHash: `0x${'11'.repeat(32)}`, requireCanonical: true })
    if (method === 'eth_getCode') return state.confirmedCode
    expect(method).toBe('eth_call')
    return ADAPT.encodeFunctionResult('nonce', [await state.nonce({ blockTag: params[1] })])
  })
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
  expect(state.nonce).toHaveBeenCalledWith({ blockTag: { blockHash: `0x${'11'.repeat(32)}`, requireCanonical: true } })
  expect(state.ratchet).toHaveBeenCalledWith(1n, 4)
  expect(state.remove).toHaveBeenCalledOnce()
})

it.each([1, 56, 42161, 137, 8453].flatMap(chainId => ['code', 'nonce'].map(read => ({ chainId, read }))))(
  'keeps cancellation evidence when branch B advances $read between branch A header reads on chain $chainId', async ({ chainId, read }) => {
    state.chainId = chainId
    // Numbered reads return branch B's valid delegation and advanced nonce, but
    // the selected block hash remains A before and after those reads.
    state.confirmedNonce = 1n
    const normal = state.rpc.getMockImplementation()!
    state.rpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === (read === 'code' ? 'eth_getCode' : 'eth_call')) {
        expect(params[1]).toEqual({ blockHash: `0x${'11'.repeat(32)}`, requireCanonical: true })
        return read === 'code' ? '0x' : ADAPT.encodeFunctionResult('nonce', [0n])
      }
      return normal(method, params)
    })
    await expect(cancelPendingSwap(session, true)).rejects.toThrow(/confirm/)
    expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
    expect(state.send).not.toHaveBeenCalled(); expect(state.payerSend).not.toHaveBeenCalled()
  },
)

it.each(['eth_getCode', 'eth_call'].flatMap(method => ['unsupported', 'malformed', 'missing'].map(failure => ({ method, failure }))))(
  'retains cancellation proof when hash-pinned $method is $failure without a numbered fallback', async ({ method, failure }) => {
    state.confirmedNonce = 1n
    const normal = state.rpc.getMockImplementation()!
    state.rpc.mockImplementation(async (name: string, params: unknown[]) => {
      if (name !== method) return normal(name, params)
      expect(params[1]).toEqual({ blockHash: `0x${'11'.repeat(32)}`, requireCanonical: true })
      if (failure === 'unsupported') throw new Error('Unsupported selector at https://provider.example/private-test-key')
      return failure === 'malformed' ? '0x1' : undefined
    })
    await expect(cancelPendingSwap(session, true)).rejects.toThrow('Cancellation state could not be verified on its canonical block. Keep the pending record.')
    expect(state.rpc.mock.calls.filter(([name]) => name === method)).toHaveLength(1)
    expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
    expect(state.send).not.toHaveBeenCalled()
  },
)

it.each([1, 56, 42161, 137])('rechecks the cancellation block after state reads before clearing on chain %s', async chainId => {
  state.chainId = chainId; state.confirmedNonce = 1n
  const normal = state.rpc.getMockImplementation()!
  state.rpc.mockImplementation(async (method: string, params: unknown[]) => {
    const result = await normal(method, params)
    if (method === 'eth_call') state.reorg = true
    return result
  })
  await expect(cancelPendingSwap(session, true)).rejects.toThrow('history changed')
  expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
  expect(state.send).not.toHaveBeenCalled()
})


it('Base keeps cancellation recovery until the contract nonce is advanced at a canonical finalized block', async () => {
  state.chainId = 8453
  await expect(cancelPendingSwap(session, true)).rejects.toThrow('confirmed invalid')
  expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
  state.confirmedNonce = 1n; state.reorg = true
  await expect(cancelPendingSwap(session, true)).rejects.toThrow('history changed')
  expect(state.remove).not.toHaveBeenCalled()
  state.reorg = false
  await expect(cancelPendingSwap(session, true)).resolves.toMatch(/invalidated/)
  expect(state.ratchet).toHaveBeenCalledWith(8453n, 4)
  expect(state.remove).toHaveBeenCalledOnce()
})

function requiresCancellation() {
  state.chainId = 42161; state.currentCode = '0x'; state.currentNonce = 0n; state.confirmedNonce = 1n
}

it('caps high fee hints, simulates the exact self-cancellation and waits before clearing', async () => {
  requiresCancellation(); state.priceCap = 50_000_000n
  await expect(cancelPendingSwap(session, true)).resolves.toMatch(/invalidated/)
  const transaction = state.send.mock.calls[0][0]
  expect(transaction).toMatchObject({ from: account, to: account, chainId: 42161n, type: 4, nonce: 0, value: 0n,
    gasLimit: 300_000n, maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 50_000_000n })
  expect(transaction.authorizationList[0].nonce).toBe(1n)
  const execution = ADAPT.decodeFunctionData('execute', transaction.data)
  expect(execution._transactions).toHaveLength(0); expect(execution._nonce).toBe(0n)
  expect(execution._actionData.calls[0].data).toBe(ADAPT.encodeFunctionData('nonce'))
  expect(state.estimate).toHaveBeenCalledWith(transaction)
  expect(state.wait).toHaveBeenCalledWith(2)
  expect(state.estimate.mock.invocationCallOrder[0]).toBeLessThan(state.send.mock.invocationCallOrder[0])
  expect(state.wait.mock.invocationCallOrder[0]).toBeLessThan(state.remove.mock.invocationCallOrder[0])
  expect(state.ratchet).toHaveBeenCalledWith(42161n, 4)
})

it('fits the funded balance without increasing the suggested priority fee', async () => {
  requiresCancellation(); state.balance.mockResolvedValue(300_000n * 40_000_000n + 123n); state.priority = 1n
  await cancelPendingSwap(session, true)
  const transaction = state.send.mock.calls[0][0]
  expect(transaction.maxFeePerGas).toBe(40_000_000n); expect(transaction.maxPriorityFeePerGas).toBe(1n)
  expect(transaction.gasLimit * transaction.maxFeePerGas).toBeLessThanOrEqual(300_000n * 40_000_000n + 123n)
})

it.each([0n, 299_999n])('keeps the record and sends nothing when %s wei cannot cover a positive allowance', async balance => {
  requiresCancellation(); state.balance.mockResolvedValue(balance)
  await expect(cancelPendingSwap(session, true)).rejects.toThrow(/Fund recovery account|cannot cover/)
  expect(state.send).not.toHaveBeenCalled(); expect(state.estimate).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
})

it.each([0n, 300_001n, new Error('simulation failed')])('blocks sending when exact cancellation simulation is unusable (%s)', async estimate => {
  requiresCancellation()
  if (estimate instanceof Error) state.estimate.mockRejectedValue(estimate)
  else state.estimate.mockResolvedValue(estimate)
  await expect(cancelPendingSwap(session, true)).rejects.toThrow()
  expect(state.send).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
})

it('refuses a balance reduction after simulation before sending', async () => {
  requiresCancellation(); state.balance.mockResolvedValueOnce(10n ** 16n).mockResolvedValueOnce(10n ** 16n).mockResolvedValueOnce(1n)
  await expect(cancelPendingSwap(session, true)).rejects.toThrow('balance changed')
  expect(state.estimate).toHaveBeenCalledOnce(); expect(state.send).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled()
})

it('keeps pending recovery when a submitted cancellation receipt fails', async () => {
  requiresCancellation(); state.wait.mockResolvedValue({ status: 0 })
  await expect(cancelPendingSwap(session, true)).rejects.toThrow('not confirmed')
  expect(state.send).toHaveBeenCalledOnce(); expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
})

function alternateCancellation() {
  requiresCancellation(); state.priceCap = 100_000_000n
  state.balance.mockImplementation(async address => address === payerAddress ? 1_031_653_663_537_909n : 0n)
}

it.each(['0x', delegation])('uses the earlier same-wallet account only for outer gas with real target signatures (%s)', async code => {
  alternateCancellation(); state.payerCode = code
  await expect(cancelPendingSwap(session, true, false, 0)).resolves.toMatch(/invalidated/)
  expect(state.derive.mock.calls).toEqual([[42161n, 3], [42161n, 0]])
  expect(state.send).not.toHaveBeenCalled(); expect(state.payerSend).toHaveBeenCalledOnce()
  const submitted = state.payerSend.mock.calls[0][0], signed = Transaction.from(state.outerRaw)
  expect(signed.from).toBe(payerAddress); expect(signed.to).toBe(account)
  expect(signed.type).toBe(4); expect(signed.value).toBe(0n); expect(signed.nonce).toBe(2)
  expect(signed.gasLimit).toBe(CANCELLATION_GAS_LIMIT)
  expect(signed.gasLimit * signed.maxFeePerGas!).toBeLessThanOrEqual(CANCELLATION_GAS_LIMIT * state.priceCap!)
  const authorization = signed.authorizationList![0]
  expect(authorization.nonce).toBe(0n); expect(verifyAuthorization(authorization, authorization.signature)).toBe(account)
  const execution = ADAPT.decodeFunctionData('execute', signed.data)
  expect(execution._transactions).toHaveLength(0); expect(execution._nonce).toBe(0n)
  expect(execution._actionData.calls).toHaveLength(1)
  expect(Array.from(execution._actionData.calls[0])).toEqual([account, ADAPT.encodeFunctionData('nonce'), 0n])
  RelayAdapt7702Validator.validateExecution([], execution._actionData, execution._signature, 42161n, account,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n })
  expect(state.estimate).toHaveBeenCalledWith(submitted)
  expect(state.balance.mock.calls.every(([address]) => address === payerAddress)).toBe(true)
  expect(state.wait).toHaveBeenCalledWith(2); expect(state.ratchet).toHaveBeenCalledWith(42161n, 4)
})

it.each([-1, 3, 4, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid alternate payer index %s before derivation', async index => {
  alternateCancellation()
  await expect(cancelPendingSwap(session, true, false, index)).rejects.toThrow('earlier recovery account')
  expect(state.derive).not.toHaveBeenCalled(); expect(state.payerSend).not.toHaveBeenCalled()
})

it.each([1, 56, 8453])('does not enable alternate payers outside Arbitrum (%s)', async chainId => {
  alternateCancellation(); state.chainId = chainId
  await expect(cancelPendingSwap(session, true, false, 0)).rejects.toThrow('Arbitrum')
  expect(state.derive).not.toHaveBeenCalled(); expect(state.payerSend).not.toHaveBeenCalled()
})

it.each(['code', 'pending', 'ceiling', 'zero', 'tiny', 'identity'])('rejects an unsafe alternate payer before any send (%s)', async change => {
  alternateCancellation()
  if (change === 'code') state.payerCode = '0x6001'
  if (change === 'pending') state.payerNonce++
  if (change === 'ceiling') state.priceCap = undefined
  if (change === 'zero') state.balance.mockResolvedValue(0n)
  if (change === 'tiny') state.balance.mockResolvedValue(299_999n)
  if (change === 'identity') state.derive.mockResolvedValueOnce(await state.derive(42161n, 3))
    .mockResolvedValueOnce({ address: payerAddress, signer: { address: account } })
  await expect(cancelPendingSwap(session, true, false, 0)).rejects.toThrow()
  expect(state.send).not.toHaveBeenCalled(); expect(state.payerSend).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
})

it.each(['target-nonce', 'payer-nonce', 'payer-latest', 'target-code', 'payer-code', 'balance'])('rechecks alternate payer/target state after simulation (%s)', async change => {
  alternateCancellation()
  state.estimate.mockImplementation(async () => {
    if (change === 'target-nonce') state.targetNonce++
    if (change === 'payer-nonce') state.payerNonce++
    if (change === 'payer-latest') state.payerLatestNonce++
    if (change === 'target-code') state.currentCode = delegation
    if (change === 'payer-code') state.payerCode = '0x'
    if (change === 'balance') state.balance.mockResolvedValue(1n)
    return 106_531n
  })
  await expect(cancelPendingSwap(session, true, false, 0)).rejects.toThrow(/state changed|balance changed/)
  expect(state.payerSend).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled()
})

it('does not spend the alternate payer balance if the target execution is already invalidated', async () => {
  alternateCancellation(); state.currentCode = delegation; state.currentNonce = 1n
  await expect(cancelPendingSwap(session, true, false, 0)).resolves.toMatch(/invalidated/)
  expect(state.derive.mock.calls).toEqual([[42161n, 3]])
  expect(state.payerSend).not.toHaveBeenCalled(); expect(state.balance).not.toHaveBeenCalled()
})

it.each([0, null])('preserves recovery after an alternate payer cancellation has no successful receipt (%s)', async status => {
  alternateCancellation(); state.wait.mockResolvedValue(status === null ? null : { status })
  await expect(cancelPendingSwap(session, true, false, 0)).rejects.toThrow('not confirmed')
  expect(state.payerSend).toHaveBeenCalledOnce(); expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
})
