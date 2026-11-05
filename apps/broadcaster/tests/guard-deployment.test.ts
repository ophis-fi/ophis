import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCreateAddress, Interface, keccak256, Transaction, Wallet, type JsonRpcProvider } from 'ethers'
import { executionGuardCode } from '../../railgun/operator/execution-guard'
import { PROTECTED_WRITE_RPC } from '../../railgun/operator/protected-provider'
import { deployGuard, type GuardApproval } from '../src/guard-deployment'
import { config } from './request.fixture'
import { NETWORK } from '../src/config'

const directories: string[] = []
const blockHash = `0x${'55'.repeat(32)}`
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock('../src/config'); vi.resetModules()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'guard-deploy-')); directories.push(state)
  const wallet = new Wallet(Wallet.createRandom().privateKey), delegateCode = '0x6001600055'
  const guard = getCreateAddress({ from: wallet.address, nonce: 0 }), expected = executionGuardCode(wallet.address, delegateCode)
  const settings = { ...config, mode: 'mainnet' as const, enabled: false, operatorAddress: wallet.address, state }
  const approval: GuardApproval = { chainId: 1, gasOperator: wallet.address, predictedGuard: guard,
    canonicalDelegate: NETWORK.relayAdapt7702Contract, expectedRuntimeKeccak256: keccak256(expected),
    gasFundingApproved: true, approvedDeploymentCostCeilingWei: '250000000000000',
    proposal: { maxGasPriceWei: '500000000', reserveWei: '1500000000000000', maxTransactionCostWei: '1500000000000000' } }
  const registry = new Interface(['function getContractAddress(string) view returns (address)'])
  const provider = { getBlock: vi.fn(async () => ({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 100_000_000n })),
    getFeeData: vi.fn(async () => ({ gasPrice: 50_000_000n, maxPriorityFeePerGas: 1n })),
    getNetwork: vi.fn(async () => ({ chainId: 1n })), getCode: vi.fn(async (address: string): Promise<string> => address === NETWORK.relayAdapt7702Contract ? delegateCode : '0x'),
    getTransactionCount: vi.fn(async () => 0), call: vi.fn(async () => registry.encodeFunctionResult('getContractAddress', [NETWORK.relayAdapt7702Contract])),
    estimateGas: vi.fn(async () => 364_662n), getBalance: vi.fn(async () => 3_500_000_000_000_000n), send: vi.fn(async () => expected) }
  const path = join(state, 'guard-deployment-signed.json'), sign = vi.spyOn(wallet, 'signTransaction')
  const publish = vi.fn(async (url, options) => {
    expect(url).toBe(PROTECTED_WRITE_RPC); expect(options.redirect).toBe('error')
    const body = JSON.parse(options.body), tx = Transaction.from(body.params[0])
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.hash).toBe(tx.hash); expect(saved.raw).toBe(body.params[0])
    expect(tx.from).toBe(wallet.address); expect(tx.to).toBeNull(); expect(tx.value).toBe(0n); expect(tx.chainId).toBe(1n)
    expect(tx.maxPriorityFeePerGas).toBe(1n)
    expect(tx.gasLimit * tx.maxFeePerGas!).toBeLessThanOrEqual(BigInt(approval.approvedDeploymentCostCeilingWei))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: tx.hash }) }
  })
  vi.stubGlobal('fetch', publish)
  const run = () => deployGuard(settings, approval, provider as unknown as JsonRpcProvider, wallet)
  return { state, settings, approval, wallet, provider, path, sign, publish, run, delegateCode, registry }
}

it('journals a bounded zero-value creation before private disclosure and prevents a second signature', async () => {
  const f = fixture()
  expect((await f.run()).guard).toBe(f.approval.predictedGuard)
  expect(f.sign).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce()
  await expect(f.run()).rejects.toThrow('already journaled')
  expect(f.sign).toHaveBeenCalledOnce()
})

it.each(['ceiling', 'reserve', 'nonce', 'runtime', 'fee', 'approval'])(
  'rejects an invalid %s before signing or disclosure', async (change) => {
    const f = fixture()
    if (change === 'ceiling') f.approval.approvedDeploymentCostCeilingWei = '1'
    if (change === 'reserve') f.provider.getBalance.mockResolvedValue(1_500_000_000_000_000n)
    if (change === 'nonce') f.provider.getTransactionCount.mockResolvedValue(1)
    if (change === 'runtime') f.provider.send.mockResolvedValue('0x6000')
    if (change === 'fee') f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 300_000_000n })
    if (change === 'approval') f.approval.gasFundingApproved = false
    await expect(f.run()).rejects.toThrow()
    expect(f.sign).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(existsSync(f.path)).toBe(false)
  },
)

it('preserves signed bytes after an unknown transport outcome and never signs a replacement', async () => {
  const f = fixture(); f.publish.mockRejectedValueOnce(new Error('timeout'))
  await expect(f.run()).rejects.toThrow('outcome is unknown')
  const saved = readFileSync(f.path, 'utf8')
  await expect(f.run()).rejects.toThrow('already journaled')
  expect(readFileSync(f.path, 'utf8')).toBe(saved); expect(f.sign).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce()
})

async function bnbFixture() {
  const f = fixture()
  vi.resetModules()
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '56')
  // Bypass only the release hold in this isolated test; every publication stays intercepted.
  vi.doMock('../src/config', async () => ({ ...await vi.importActual<typeof import('../src/config')>('../src/config'),
    assertSigningNetwork: vi.fn() }))
  const { NETWORK: bnb } = await import('../src/config')
  const { deployGuard: deployBNB } = await import('../src/guard-deployment')
  const expected = executionGuardCode(f.wallet.address, f.delegateCode, bnb.relayAdapt7702Contract)
  Object.assign(f.settings, { chainId: 56, maxGasPrice: 500_000_000n,
    maxTransactionCost: 1_500_000_000_000_000n, reserve: 1_500_000_000_000_000n })
  Object.assign(f.approval, { chainId: 56, canonicalDelegate: bnb.relayAdapt7702Contract,
    expectedRuntimeKeccak256: keccak256(expected) })
  f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash,
    timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 0n })
  f.provider.getNetwork.mockResolvedValue({ chainId: 56n })
  f.provider.getCode.mockImplementation(async (address) => address === bnb.relayAdapt7702Contract ? f.delegateCode : '0x')
  f.provider.call.mockResolvedValue(f.registry.encodeFunctionResult('getContractAddress', [bnb.relayAdapt7702Contract]))
  f.provider.send.mockResolvedValue(expected)
  f.publish.mockImplementation(async (url, options) => {
    expect(url).toBe('https://puissant-builder.48.club/')
    expect(options.redirect).toBe('error')
    const body = JSON.parse(options.body), tx = Transaction.from(body.params[0].txs[0])
    const saved = JSON.parse(readFileSync(f.path, 'utf8'))
    expect(saved.submission).toBe(options.body)
    expect(saved.hash).toBe(tx.hash)
    expect(saved.raw).toBe(tx.serialized)
    expect(body.params[0].maxTimestamp).toBeGreaterThanOrEqual(Math.floor(saved.createdAt / 1000) + 29)
    expect(body.params[0].maxTimestamp).toBeLessThanOrEqual(Math.floor(saved.createdAt / 1000) + 30)
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{
      txs: [tx.serialized], maxBlockNumber: 120, maxTimestamp: body.params[0].maxTimestamp,
      revertingTxHashes: [], noMerge: true,
    }] })
    expect(tx.chainId).toBe(56n)
    expect(tx.maxFeePerGas).toBe(500_000_000n)
    expect(tx.maxPriorityFeePerGas).toBe(50_000_000n)
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x${'ab'.repeat(32)}` }) }
  })
  return { ...f, run: () => deployBNB(f.settings, f.approval, f.provider as unknown as JsonRpcProvider, f.wallet) }
}

it('persists the exact BNB deployment bundle and returns its acknowledgment separately from the signed transaction hash', async () => {
  const f = await bnbFixture()
  const result = await f.run()
  const saved = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(result.hash).toBe(saved.hash)
  expect(result.bundleHash).toBe(`0x${'ab'.repeat(32)}`)
  expect(result.bundleHash).not.toBe(result.hash)
  expect(f.provider.estimateGas).toHaveBeenCalledWith(expect.objectContaining({ maxPriorityFeePerGas: 50_000_000n }))
  expect(f.provider.send).toHaveBeenCalledWith('eth_call', [expect.objectContaining({ maxPriorityFeePerGas: '0x2faf080' }), '0x64'])
  expect(f.sign).toHaveBeenCalledOnce()
  expect(f.publish).toHaveBeenCalledOnce()
  await expect(f.run()).rejects.toThrow('already journaled')
  expect(f.sign).toHaveBeenCalledOnce()
})

it.each(['timeout', 'duplicate', 'malformed acknowledgment'])('holds the exact BNB deployment record after %s, including after expiry', async (kind) => {
  const f = await bnbFixture()
  if (kind === 'timeout') f.publish.mockRejectedValueOnce(new Error('private upstream credentials'))
  if (kind === 'duplicate') f.publish.mockResolvedValueOnce({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1,
    error: { code: -38000, message: 'private upstream credentials' } }) } as never)
  if (kind === 'malformed acknowledgment') f.publish.mockResolvedValueOnce({ ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1234' }) })
  await expect(f.run()).rejects.toThrow('Deployment outcome is unknown')
  const saved = readFileSync(f.path, 'utf8')
  const now = Date.now() + 31_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try { await expect(f.run()).rejects.toThrow('already journaled') } finally { clock.mockRestore() }
  expect(readFileSync(f.path, 'utf8')).toBe(saved)
  expect(f.sign).toHaveBeenCalledOnce()
  expect(f.publish).toHaveBeenCalledOnce()
})

it('rejects stale BNB deployment heads before signing, persisting or disclosing a bundle', async () => {
  const f = await bnbFixture()
  f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash,
    timestamp: Math.floor(Date.now() / 1000) - 60, baseFeePerGas: 0n })
  await expect(f.run()).rejects.toThrow('stale')
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(existsSync(f.path)).toBe(false)
})

it('checks BNB head freshness again after a delayed constructor simulation before signing', async () => {
  const f = await bnbFixture(), simulated = await f.provider.send()
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  f.provider.send.mockImplementation(async () => { clock.mockReturnValue(now + 4_000); return simulated })
  try {
    await expect(f.run()).rejects.toThrow('expired before deployment signing')
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
    expect(existsSync(f.path)).toBe(false)
  } finally { clock.mockRestore() }
})

it('durably retains a BNB signature when the trusted head expires during signing and blocks another signature', async () => {
  const f = await bnbFixture(), now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  f.sign.mockImplementationOnce(async (transaction) => {
    const raw = await Wallet.prototype.signTransaction.call(f.wallet, transaction)
    clock.mockReturnValue(now + 46_000)
    return raw
  })
  try {
    await expect(f.run()).rejects.toThrow('signature remains journaled without a valid bundle')
    const bytes = readFileSync(f.path, 'utf8'), saved = JSON.parse(bytes), tx = Transaction.from(saved.raw)
    expect(saved.hash).toBe(tx.hash)
    expect(tx.chainId).toBe(56n)
    expect(tx.from).toBe(f.wallet.address)
    expect(saved.submission).toBeUndefined()
    expect(saved.submissionHeld).toBe(true)
    expect(saved.confirmed).toBe(false)
    expect(f.publish).not.toHaveBeenCalled()
    await expect(f.run()).rejects.toThrow('already journaled')
    expect(readFileSync(f.path, 'utf8')).toBe(bytes)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.publish).not.toHaveBeenCalled()
  } finally { clock.mockRestore() }
})

it('refreshes the trusted BNB head after a slow signature before persisting the exact publication envelope', async () => {
  const f = await bnbFixture(), now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  let signed = false
  f.sign.mockImplementationOnce(async (transaction) => {
    const raw = await Wallet.prototype.signTransaction.call(f.wallet, transaction)
    clock.mockReturnValue(now + 60_000)
    signed = true
    return raw
  })
  f.provider.getBlock.mockImplementation(async () => ({ number: signed ? 200 : 100, hash: blockHash,
    timestamp: Math.floor((signed ? now + 60_000 : now) / 1000), baseFeePerGas: 0n }))
  f.publish.mockImplementation(async (url, options) => {
    expect(url).toBe('https://puissant-builder.48.club/')
    const saved = JSON.parse(readFileSync(f.path, 'utf8')), body = JSON.parse(options.body)
    expect(saved.submission).toBe(options.body)
    expect(body.params[0].maxBlockNumber).toBe(220)
    expect(body.params[0].maxTimestamp).toBe(Math.floor((now + 60_000) / 1000) + 30)
    expect(body.params[0].txs).toEqual([saved.raw])
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x${'ab'.repeat(32)}` }) }
  })
  try {
    await f.run()
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.publish).toHaveBeenCalledOnce()
    expect(f.provider.getBlock.mock.calls.length).toBe(4)
  } finally { clock.mockRestore() }
})
