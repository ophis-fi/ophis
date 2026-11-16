import { afterEach, expect, it, vi } from 'vitest'
import { id, Interface, toBeHex, toQuantity, type JsonRpcProvider, type TransactionReceipt } from 'ethers'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

async function fixture() {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '8453')
  const { finalizedCreditReceipt, finalizedCreditEvidence } = await import('../src/credit-payment')
  const receipt = { hash: id('base tx'), blockHash: id('base block'), blockNumber: 100,
    status: 1, gasUsed: 21_000n, gasPrice: 100n } as TransactionReceipt
  const raw: Record<string, unknown> = { transactionHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: '0x64',
    status: '0x1', gasUsed: toQuantity(receipt.gasUsed), effectiveGasPrice: toQuantity(receipt.gasPrice), l1Fee: '0x7b' }
  const state = { operatorFee: toBeHex(456n, 32) }
  const send = vi.fn(async (method: string) => method === 'eth_getTransactionReceipt' ? raw : state.operatorFee)
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ number: 100, hash: receipt.blockHash, timestamp: 1_700_000_000 }), send } as unknown as JsonRpcProvider
  return { receipt, raw, state, send, provider, finalizedCreditEvidence,
    check: () => finalizedCreditReceipt(provider, receipt.hash) }
}

it.each([0, 1])('includes execution, L1 and operator fees for Base receipt status %s', async (status) => {
  const f = await fixture()
  Object.assign(f.receipt, { status }); f.raw.status = toQuantity(status)
  await f.check()
  expect(f.finalizedCreditEvidence(f.receipt).networkCost).toBe(2_100_579n)
  expect(f.send).toHaveBeenCalledWith('eth_call', [{ to: '0x420000000000000000000000000000000000000F',
    data: new Interface(['function getOperatorFee(uint256) view returns (uint256)']).encodeFunctionData('getOperatorFee', [21_000n]) },
    { blockHash: f.receipt.blockHash, requireCanonical: true }])
  f.raw.l1Fee = '0xffff'; Object.assign(f.receipt, { gasPrice: 999n })
  expect(f.finalizedCreditEvidence(f.receipt).networkCost).toBe(2_100_579n)
})

it.each([undefined, null, 123, '123', '-1', '0x', '0x00', `0x1${'0'.repeat(64)}`])(
  'refuses incomplete or malformed L1 fee evidence: %s', async (fee) => {
    const f = await fixture(); f.raw.l1Fee = fee
    await expect(f.check()).rejects.toThrow('fee evidence')
    expect(() => f.finalizedCreditEvidence(f.receipt)).toThrow('verified finalized')
  },
)

it.each(['transactionHash', 'blockHash', 'blockNumber', 'status', 'gasUsed', 'effectiveGasPrice'])(
  'refuses raw receipts with changed %s', async (field) => {
    const f = await fixture(); f.raw[field] = field.endsWith('Hash') ? id('changed') : '0x0'
    await expect(f.check()).rejects.toThrow('does not match')
  },
)

it('accepts verified zero extra fees but never substitutes zero for an unavailable operator fee', async () => {
  const f = await fixture(); f.raw.l1Fee = '0x0'; f.state.operatorFee = toBeHex(0n, 32)
  await f.check()
  expect(f.finalizedCreditEvidence(f.receipt).networkCost).toBe(2_100_000n)
  const missing = await fixture(); missing.state.operatorFee = '0x'
  await expect(missing.check()).rejects.toThrow('does not match')
  const failed = await fixture(); failed.send.mockRejectedValue(new Error('historical call unavailable'))
  await expect(failed.check()).rejects.toThrow('historical call unavailable')
  expect(() => failed.finalizedCreditEvidence(failed.receipt)).toThrow('verified finalized')
})
