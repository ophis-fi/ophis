import { expect, it, vi } from 'vitest'
import { id, Interface, toQuantity, Transaction, Wallet, ZeroAddress, type TransactionRequest } from 'ethers'
import { BASE_SETUP_MAX_FEE_PER_GAS, BASE_SETUP_MAX_FUNDING, quoteBaseRefundFees, quoteBaseSetupFees } from './base-setup-fees'

const wallet = new Wallet('0x' + '11'.repeat(32)), other = new Wallet('0x' + '22'.repeat(32))
const delegate = '0x0000000000000000000000000000000000001234'
const abi = new Interface(['function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)'])
async function fixture() {
  const state = { chainId: 8453n, reorg: false, timestamp: Math.floor(Date.now() / 1000), l1: 11n, operator: 7n, estimate: 21_000n,
    maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n, malformed: false }
  const send = vi.fn(async (_method: string, params: any[]) => {
    if (_method === 'eth_estimateGas') { expect(params[1]).toBe('0x64'); return toQuantity(state.estimate) }
    expect(_method).toBe('eth_call'); expect(params[1]).toEqual({ blockHash: id('head'), requireCanonical: true })
    const method = abi.parseTransaction(params[0])!.name
    return state.malformed ? '0x1' : abi.encodeFunctionResult(method, [method === 'getL1FeeUpperBound' ? state.l1 : state.operator])
  })
  const provider = { getNetwork: async () => ({ chainId: state.chainId }),
    getBlock: async (tag: string | number) => ({ number: 100, timestamp: state.timestamp, hash: state.reorg && tag === 100 ? id('reorg') : id('head') }),
    getFeeData: vi.fn(async () => ({ maxFeePerGas: state.maxFeePerGas, maxPriorityFeePerGas: state.maxPriorityFeePerGas })), send,
    estimateGas: vi.fn(async () => state.estimate) }
  const tx: TransactionRequest = { from: wallet.address, to: ZeroAddress, type: 4, chainId: 8453n, nonce: 0, value: 0n,
    data: '0x', gasLimit: 46_000n, authorizationList: [await wallet.authorize({ chainId: 8453n, nonce: 1, address: delegate })] }
  const p = provider as unknown as Parameters<typeof quoteBaseRefundFees>[0]
  return { state, provider, p, tx, refund: { from: wallet.address, to: other.address, type: 2, chainId: 8453n,
    nonce: 0, value: 100n, data: '0x' } as TransactionRequest }
}

it('quotes execution plus twice L1 and operator estimates, with no authorization disclosure', async () => {
  const f = await fixture(), quote = await quoteBaseSetupFees(f.p, f.tx)
  expect(quote).toMatchObject({ gasLimit: '46000', executionMaximum: '920000000000', l1FeeEstimate: '11', operatorFeeEstimate: '7',
    maximumNetworkFee: '920000000036', feeBound: 'estimate-only', blockNumber: 100, blockHash: id('head') })
  expect(() => JSON.stringify(quote)).not.toThrow()
  const { from: _from, ...request } = f.tx
  const tx = Transaction.from({ ...request, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n } as any)
  expect(quote.unsignedHash).toBe(tx.unsignedHash)
  expect(f.provider.send).toHaveBeenCalledTimes(2)
  expect(abi.parseTransaction(f.provider.send.mock.calls[0][1][0])!.args[0]).toBe(BigInt((tx.unsignedSerialized.length - 2) / 2))
  expect(abi.parseTransaction(f.provider.send.mock.calls[1][1][0])!.args[0]).toBe(46_000n)
  expect(JSON.stringify(f.provider.send.mock.calls)).not.toContain((f.tx.authorizationList![0] as any).signature.r.slice(2))
  expect(f.provider.estimateGas).not.toHaveBeenCalled()
})

it.each(['chain', 'reorg', 'stale', 'fee-cap', 'tip', 'extra-fees', 'malformed'])('rejects unavailable or excessive %s evidence', async field => {
  const f = await fixture()
  if (field === 'chain') f.state.chainId = 1n
  if (field === 'reorg') f.state.reorg = true
  if (field === 'stale') f.state.timestamp -= 46
  if (field === 'fee-cap') f.state.maxFeePerGas = BASE_SETUP_MAX_FEE_PER_GAS + 1n
  if (field === 'tip') f.state.maxPriorityFeePerGas = f.state.maxFeePerGas + 1n
  if (field === 'extra-fees') f.state.l1 = BASE_SETUP_MAX_FUNDING
  if (field === 'malformed') f.state.malformed = true
  await expect(quoteBaseSetupFees(f.p, f.tx)).rejects.toThrow('Base setup fee estimate')
})

it('requires self-authorized nonce1 inside outer nonce0 and the exact zero-value setup shape', async () => {
  const f = await fixture()
  const variants: TransactionRequest[] = [
    { ...f.tx, nonce: 1 }, { ...f.tx, value: 1n }, { ...f.tx, to: other.address }, { ...f.tx, gasLimit: 45_999n },
    { ...f.tx, type: 2 }, { ...f.tx, data: '0x01' }, { ...f.tx, from: other.address }, { ...f.tx, chainId: 1 },
    { ...f.tx, authorizationList: [] }, { ...f.tx, authorizationList: [...f.tx.authorizationList!, ...f.tx.authorizationList!] },
    { ...f.tx, authorizationList: [await wallet.authorize({ chainId: 8453n, nonce: 0, address: delegate })] },
    { ...f.tx, authorizationList: [await wallet.authorize({ chainId: 1n, nonce: 1, address: delegate })] },
  ]
  for (const tx of variants) await expect(quoteBaseSetupFees(f.p, tx)).rejects.toThrow()
})

it('retains exact reviewed fee caps and refuses partial fee fields', async () => {
  const f = await fixture()
  const quote = await quoteBaseSetupFees(f.p, { ...f.tx, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 100n })
  expect(quote.maxFeePerGas).toBe('10000000'); expect(quote.maxPriorityFeePerGas).toBe('100')
  expect(f.provider.getFeeData).not.toHaveBeenCalled()
  await expect(quoteBaseSetupFees(f.p, { ...f.tx, maxFeePerGas: 1n })).rejects.toThrow()
})

it('quotes an exact positive-value nonce0 recovery with bounded gas and complete extras', async () => {
  const f = await fixture(), quote = await quoteBaseRefundFees(f.p, f.refund)
  expect(quote).toMatchObject({ gasLimit: '25200', executionMaximum: '504000000000', maximumNetworkFee: '504000000036' })
  expect(f.provider.send).toHaveBeenCalledWith('eth_estimateGas', [expect.objectContaining({ from: wallet.address, to: other.address,
    value: '0x64', nonce: '0x0', type: '0x2', data: '0x' }), '0x64'])
  expect(f.provider.estimateGas).not.toHaveBeenCalled()
  const same = await quoteBaseRefundFees(f.p, { ...f.refund, nonce: 2, gasLimit: 30_000n, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n })
  expect(same.gasLimit).toBe('30000'); expect(same.unsignedHash).not.toBe(quote.unsignedHash)
  const changedValue = await quoteBaseRefundFees(f.p, { ...f.refund, value: 101n })
  expect(changedValue.unsignedHash).not.toBe(quote.unsignedHash)
})

it('rejects oversized refund gas, low retained gas, extra authorization and excess recovery value', async () => {
  const f = await fixture()
  for (const estimate of [100_001n, 84_000n, 20_999n]) {
    f.state.estimate = estimate; await expect(quoteBaseRefundFees(f.p, f.refund)).rejects.toThrow()
  }
  f.state.estimate = 21_000n
  for (const tx of [{ ...f.refund, gasLimit: 20_999n }, { ...f.refund, gasLimit: 100_001n },
    { ...f.refund, authorizationList: f.tx.authorizationList }, { ...f.refund, value: BASE_SETUP_MAX_FUNDING + 1n },
    { ...f.refund, nonce: -1 }, { ...f.refund, to: ZeroAddress }, { ...f.refund, data: '0x01' }])
    await expect(quoteBaseRefundFees(f.p, tx)).rejects.toThrow()
})
