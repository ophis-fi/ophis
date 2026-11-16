import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AbiCoder, Interface, JsonRpcProvider, Wallet, ZeroHash, zeroPadValue } from 'ethers'
import { ABIRailgunSmartWallet, ABIRelayAdapt7702, RelayAdapt7702ExecutionType,
  RelayAdapt7702Helper, signExecutionAuthorization, type TransactionStructV2 } from '@railgun-community/engine'
import { executionGuardCode, EXECUTION_GUARD } from '../operator/execution-guard'
import type { PendingSwap } from './journal'
import type { PendingWithdrawal } from './withdrawal-journal'

beforeEach(() => { vi.resetModules(); vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '42161') })
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

async function fixture() {
  const { CONFIG, VERSION } = await import('./config'), { diagnoseSavedTransaction } = await import('./prepaid-diagnostic')
  const account = new Wallet(`0x${'11'.repeat(32)}`), operator = new Wallet(`0x${'22'.repeat(32)}`).address
  const guard = new Wallet(`0x${'33'.repeat(32)}`).address, nullifier = `0x${'44'.repeat(32)}`
  const adapt = new Interface(ABIRelayAdapt7702), privacy = new Interface(ABIRailgunSmartWallet)
  const type = privacy.getFunction('transact')!.inputs[0].arrayChildren!
  const tx = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([type])[0])
  tx[type.components!.findIndex(p => p.name === 'nullifiers')] = [nullifier]
  tx[type.components!.findIndex(p => p.name === 'commitments')] = [ZeroHash]
  const transactions = [tx as unknown as TransactionStructV2], action = RelayAdapt7702Helper.getActionData(false, [], 0n)
  const signature = await signExecutionAuthorization(account, transactions, action, 42161,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n })
  const authorization = await account.authorize({ chainId: 42161, nonce: 0, address: CONFIG.relayAdapt7702Contract })
  const request = JSON.parse(JSON.stringify({ chainID: 42161, chainType: 0, txidVersion: VERSION, transactType: 'TX7702',
    useRelayAdapt: true, to: account.address, data: adapt.encodeFunctionData('execute', [transactions, action, 0n, signature]),
    authorization, gasLimit: '1000000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
  (_, v) => typeof v === 'bigint' ? v.toString() : v))
  const pending: PendingSwap = { chainId: 42161, feeMode: 'prepaid', index: 0, account: account.address, token: 'WETH',
    npk: ZeroHash, minimum: '1', executeNonce: '0', fromBlock: 123, inputs: [{ tree: 0, nullifier }] }
  const block = { number: 123, hash: `0x${'55'.repeat(32)}` }, delegateCode = '0x6001'
  const batch = privacy.encodeFunctionData('transact', [transactions])
  const success = { type: 'CALL', to: guard, calls: [{ type: 'CALL', to: account.address,
    calls: [{ type: 'CALL', to: CONFIG.proxyContract, input: batch }] }] }
  const serializer = new JsonRpcProvider('http://127.0.0.1:1')
  // Every provider read is mocked; only the pure ethers request serializer is used.
  const provider = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 42161n }), getBlock: vi.fn().mockResolvedValue(block),
    getCode: vi.fn(async (address: string, _block: number) => address === CONFIG.relayAdapt7702Contract ? delegateCode : address === guard
      ? executionGuardCode(operator, delegateCode, CONFIG.relayAdapt7702Contract) : '0x'),
    getTransactionCount: vi.fn().mockResolvedValue(1), getRpcTransaction: serializer.getRpcTransaction.bind(serializer),
    send: vi.fn(async (method: string, _params: unknown[]): Promise<unknown> => {
      if (method === 'eth_estimateGas') return '0x186a1' // 100001, tests ceiling rather than truncation.
      if (method === 'debug_traceCall') return success
      throw new Error('Forbidden RPC method')
    }),
  }
  serializer.destroy()
  const run = () => diagnoseSavedTransaction(provider as unknown as Parameters<typeof diagnoseSavedTransaction>[0], request, pending, operator, guard)
  return { run, request, pending, provider, block, guard, operator, account, adapt, CONFIG, success }
}

it('reconstructs one pinned historical guarded call with real signature validation and no writes', async () => {
  const f = await fixture(), before = JSON.stringify({ request: f.request, pending: f.pending })
  expect(JSON.parse(await f.run())).toEqual({ stage: 'historical-trace', category: 'success',
    savedGas: '1000000', estimatedGas: '100001', tracedGas: '110002' })
  expect(f.provider.send.mock.calls.map(c => c[0])).toEqual(['eth_estimateGas', 'debug_traceCall'])
  const calls = f.provider.send.mock.calls as unknown as [string, unknown[]][]
  const [rpc, tag, options] = calls[1][1] as [Record<string, unknown>, string, unknown]
  expect(tag).toBe('0x7b'); expect(options).toEqual({ tracer: 'callTracer', timeout: '5s' })
  expect(rpc).toMatchObject({ from: f.operator.toLowerCase(), to: f.guard.toLowerCase(), type: '0x4', nonce: '0x1', gas: '0x1adb2', value: '0x0' })
  const decoded = EXECUTION_GUARD.decodeFunctionData('execute', String(rpc.data))
  expect(decoded.account).toBe(f.account.address); expect(decoded.execution).toBe(f.request.data)
  expect(f.provider.getBlock.mock.calls).toEqual([[123], [123]])
  expect(f.provider.getCode.mock.calls.every(c => c[1] === 123)).toBe(true)
  expect(JSON.stringify({ request: f.request, pending: f.pending })).toBe(before)
})

it.each(['chain', 'account', 'nonce', 'nullifier', 'tree', 'authorization', 'signature', 'calldata', 'hash'])('rejects saved %s mismatch before RPC', async change => {
  const f = await fixture()
  if (change === 'chain') f.request.chainID = 1
  if (change === 'account') f.pending.account = f.operator
  if (change === 'nonce') f.pending.executeNonce = '1'
  if (change === 'nullifier') f.pending.inputs![0].nullifier = ZeroHash
  if (change === 'tree') f.pending.inputs![0].tree = 1
  if (change === 'authorization') f.request.authorization.signature.s = ZeroHash
  if (change === 'signature') {
    const args = Array.from(f.adapt.decodeFunctionData('execute', f.request.data)); args[3] = `0x${'00'.repeat(65)}`
    f.request.data = f.adapt.encodeFunctionData('execute', args)
  }
  if (change === 'calldata') f.request.data += '00'
  if (change === 'hash') f.pending.hash = ZeroHash
  expect(JSON.parse(await f.run())).toEqual({ stage: 'binding', category: 'saved-binding-invalid' })
  expect(f.provider.getNetwork).not.toHaveBeenCalled(); expect(f.provider.send).not.toHaveBeenCalled()
})

it('refuses incorrect historical code and gas above the saved allowance without tracing', async () => {
  const f = await fixture(); f.provider.getCode.mockResolvedValue('0x')
  expect(JSON.parse(await f.run()).stage).toBe('historical-code'); expect(f.provider.send).not.toHaveBeenCalled()
  const g = await fixture(); g.request.gasLimit = '110001'
  expect(JSON.parse(await g.run()).category).toBe('saved-gas-exceeded')
  expect(g.provider.send.mock.calls.map(c => c[0])).toEqual(['eth_estimateGas'])
})

it('censors all provider messages, nested data, request bodies and endpoints', async () => {
  const f = await fixture(), sentinel = 'PRIVATE_ENDPOINT_CALldata_PASSWORD'
  f.provider.send.mockRejectedValue({ message: sentinel, info: { error: { code: -32602, message: sentinel, data: sentinel }, request: sentinel } })
  const output = await f.run()
  expect(JSON.parse(output)).toEqual({ stage: 'historical-estimate', category: 'invalid-params', rpcCode: -32602 })
  expect(output).not.toContain(sentinel); expect(f.provider.getBlock).toHaveBeenCalledTimes(2)
})

it('reports only a finite deepest failing role/path, ABI name and gas metrics', async () => {
  const f = await fixture(), sentinel = 'SECRET_REVERT_STRING'
  const failed = { type: 'CALL', to: f.guard, error: sentinel, calls: [{ type: 'CALL', to: f.account.address,
    error: sentinel, output: EXECUTION_GUARD.getError('ExecutionFailed')!.selector + 'ff'.repeat(32), gas: '0x64', gasUsed: '0x32' }] }
  f.provider.send.mockImplementation(async method => method === 'eth_estimateGas' ? '0x186a1' : failed)
  const output = await f.run(), result = JSON.parse(output)
  expect(result).toMatchObject({ category: 'node-error', role: 'account', path: '0', errorName: 'ExecutionFailed', gas: '100', gasUsed: '50' })
  expect(output).not.toContain(sentinel); expect(output).not.toContain(f.account.address); expect(output).not.toContain('ff'.repeat(32))
})

it('rejects missing exact batch, malformed nodes and oversized call trees', async () => {
  for (const [trace, category] of [[{ type: 'CALL' }, 'exact-batch-absent'], [{ calls: [] }, 'malformed'],
    [{ type: 'CALL', calls: Array.from({ length: 4096 }, () => ({ type: 'CALL' })) }, 'limit']] as const) {
    const f = await fixture(); f.provider.send.mockImplementation(async method => method === 'eth_estimateGas' ? '0x186a1' : trace)
    expect(JSON.parse(await f.run()).category).toBe(category)
  }
})

it('never reports success when the historical block changes', async () => {
  const f = await fixture(); f.provider.getBlock.mockResolvedValueOnce(f.block).mockResolvedValue({ ...f.block, hash: ZeroHash })
  expect(JSON.parse(await f.run())).toEqual({ stage: 'canonical-recheck', category: 'reorg' })
})

it('times out without dispatching any later RPC even if the in-flight read subsequently resolves', async () => {
  const f = await fixture(); vi.useFakeTimers()
  let resolve!: (value: unknown) => void
  f.provider.getNetwork.mockImplementation(() => new Promise(r => { resolve = r }))
  const running = f.run(); await vi.advanceTimersByTimeAsync(30_000)
  expect(JSON.parse(await running)).toEqual({ stage: 'network', category: 'timeout' })
  resolve({ chainId: 42161n }); await Promise.resolve(); await Promise.resolve()
  expect(f.provider.getBlock).not.toHaveBeenCalled(); expect(f.provider.send).not.toHaveBeenCalled()
})

async function withdrawalFixture() {
  const f = await fixture(), { diagnoseSavedTransaction } = await import('./prepaid-diagnostic')
  const { tokenFor, VERSION } = await import('./config'), privacy = new Interface(ABIRailgunSmartWallet)
  const tuple = privacy.getFunction('transact')!.inputs[0].arrayChildren!
  const proof = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([tuple])[0])
  const field = (name: string) => tuple.components!.findIndex(p => p.name === name)
  const params = tuple.components![field('boundParams')].components!, bound = Array.from(proof[field('boundParams')] as unknown[])
  for (const [name, value] of [['unshield', 1n], ['chainID', 42161n]] as const) bound[params.findIndex(p => p.name === name)] = value
  proof[field('boundParams')] = bound
  proof[field('nullifiers')] = [f.pending.inputs![0].nullifier]
  proof[field('commitments')] = [ZeroHash]
  proof[field('unshieldPreimage')] = [zeroPadValue(f.account.address, 32), [0, tokenFor('USDC').address, 0], 188659n]
  const data = privacy.encodeFunctionData('transact', [[proof]])
  const request = { chainID: 42161, chainType: 0, txidVersion: VERSION, transactType: 'COMMON', useRelayAdapt: false,
    to: f.CONFIG.proxyContract, data, minGasPrice: '20064000' }
  const pending: PendingWithdrawal = { chainId: 42161, feeMode: 'prepaid', token: 'USDC', recipient: f.account.address,
    minimum: '188188', fromBlock: 123, nullifiers: [f.pending.inputs![0].nullifier], minGasPrice: '20064000',
    transaction: { to: request.to, data, value: '0' } }
  const block = { ...f.block, baseFeePerGas: 20_064_000n }
  f.provider.getBlock.mockResolvedValue(block)
  f.provider.getCode.mockImplementation(async address => address === f.CONFIG.proxyContract ? '0x6001' : '0x')
  f.provider.send.mockImplementation(async method => {
    if (method === 'eth_estimateGas') return '0x186a1'
    if (method === 'debug_traceCall') return { type: 'CALL', to: request.to, input: data }
    throw new Error('Forbidden RPC method')
  })
  return { ...f, request, pending, privacy, block,
    run: () => diagnoseSavedTransaction(f.provider as unknown as Parameters<typeof diagnoseSavedTransaction>[0], request, pending, f.operator, f.guard) }
}

it('reconstructs exact COMMON calldata with the operator and historical gas floor, without SDK type-2 fields or writes', async () => {
  const f = await withdrawalFixture(), before = JSON.stringify({ request: f.request, pending: f.pending })
  expect(JSON.parse(await f.run())).toMatchObject({ stage: 'historical-trace', category: 'success' })
  const calls = f.provider.send.mock.calls as unknown as [string, unknown[]][]
  expect(calls.map(c => c[0])).toEqual(['eth_estimateGas', 'debug_traceCall'])
  expect(calls[0][1][1]).toBe('0x7b')
  expect(calls[0][1][0]).toEqual({ chainId: '0xa4b1', type: '0x1', gasPrice: '0x1322701', nonce: '0x1', value: '0x0',
    from: f.operator.toLowerCase(), to: f.request.to.toLowerCase(), data: f.request.data })
  expect(JSON.stringify({ request: f.request, pending: f.pending })).toBe(before)
  expect(f.provider.getBlock.mock.calls).toEqual([[123], [123]])
})

it.each(['chain', 'calldata', 'recipient', 'token', 'nullifier', 'gas', 'value', 'hash'])('rejects mismatched saved COMMON %s before RPC', async change => {
  const f = await withdrawalFixture()
  if (change === 'chain') f.pending.chainId = 1
  if (change === 'calldata') f.pending.transaction.data += '00'
  if (change === 'recipient') f.pending.recipient = f.operator
  if (change === 'token') f.pending.token = 'WETH'
  if (change === 'nullifier') f.pending.nullifiers = [ZeroHash]
  if (change === 'gas') f.request.minGasPrice = '1'
  if (change === 'value') f.pending.transaction.value = '1'
  if (change === 'hash') f.pending.hash = ZeroHash
  expect(JSON.parse(await f.run())).toEqual({ stage: 'binding', category: 'saved-binding-invalid' })
  expect(f.provider.getNetwork).not.toHaveBeenCalled(); expect(f.provider.send).not.toHaveBeenCalled()
})

it.each([
  ['RailgunSmartWallet: Invalid Snark Proof', 'snark-proof'],
  ['RailgunSmartWallet: Invalid Merkle Root', 'merkle-root'],
  ['RailgunLogic: Note already spent', 'input-spent'],
  ['PRIVATE_PASSWORD_ENDPOINT_CALLDATA', 'unclassified-revert'],
])('reports a finite COMMON rejection code for %s without exposing error contents', async (reason, rejection) => {
  const f = await withdrawalFixture()
  f.provider.send.mockRejectedValue({ code: 'CALL_EXCEPTION', message: 'PRIVATE_PASSWORD_ENDPOINT_CALLDATA',
    info: { error: { code: 3, data: f.privacy.encodeErrorResult('Error', [reason]) } } })
  const output = await f.run()
  expect(JSON.parse(output)).toEqual({ stage: 'historical-estimate', category: 'execution', rpcCode: 3, rejection })
  expect(output).not.toContain(reason); expect(output).not.toContain('PRIVATE_PASSWORD_ENDPOINT_CALLDATA')
  expect(f.provider.send).toHaveBeenCalledTimes(1)
})

it('separates a base fee rejection from a proof failure and stops after one estimate', async () => {
  const f = await withdrawalFixture()
  f.provider.send.mockRejectedValue({ info: { error: { code: -32000, message: 'max fee per gas less than block base fee: PRIVATE_VALUE' } } })
  expect(JSON.parse(await f.run())).toEqual({ stage: 'historical-estimate', category: 'fee-below-base', rpcCode: -32000 })
  expect(f.provider.send).toHaveBeenCalledTimes(1)
})
