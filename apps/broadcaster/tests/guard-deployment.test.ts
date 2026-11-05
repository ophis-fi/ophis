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
afterEach(() => { vi.unstubAllGlobals(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

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
    getNetwork: vi.fn(async () => ({ chainId: 1n })), getCode: vi.fn(async (address: string) => address === NETWORK.relayAdapt7702Contract ? delegateCode : '0x'),
    getTransactionCount: vi.fn(async () => 0), call: vi.fn(async () => registry.encodeFunctionResult('getContractAddress', [NETWORK.relayAdapt7702Contract])),
    estimateGas: vi.fn(async () => 364_662n), getBalance: vi.fn(async () => 3_500_000_000_000_000n), send: vi.fn(async () => expected) }
  const path = join(state, 'guard-deployment-signed.json'), sign = vi.spyOn(wallet, 'signTransaction')
  const publish = vi.fn(async (url, options) => {
    expect(url).toBe(PROTECTED_WRITE_RPC); expect(options.redirect).toBe('error')
    const body = JSON.parse(options.body), tx = Transaction.from(body.params[0])
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.hash).toBe(tx.hash); expect(saved.raw).toBe(body.params[0])
    expect(tx.from).toBe(wallet.address); expect(tx.to).toBeNull(); expect(tx.value).toBe(0n); expect(tx.chainId).toBe(1n)
    expect(tx.gasLimit * tx.maxFeePerGas!).toBeLessThanOrEqual(BigInt(approval.approvedDeploymentCostCeilingWei))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: tx.hash }) }
  })
  vi.stubGlobal('fetch', publish)
  const run = () => deployGuard(settings, approval, provider as unknown as JsonRpcProvider, wallet)
  return { state, settings, approval, wallet, provider, path, sign, publish, run }
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
