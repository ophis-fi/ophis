import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Contract, JsonRpcProvider, JsonRpcSigner } from 'ethers'
import { ERC20, OPHIS_FEE, TOKENS } from './config'
import { quoteSwap, recipeCalls } from './recipe'

const enabled = process.env.RAILGUN_FORK_TEST === '1'
const provider = new JsonRpcProvider('http://127.0.0.1:8549', 1)
const control: { snapshot?: string; signer?: JsonRpcSigner } = {}

describe.skipIf(!enabled)('Ethereum fork: private-swap pool calls', () => {
  beforeAll(async () => {
    const metadata = await provider.send('anvil_metadata', [])
    if (!metadata.forkedNetwork) throw new Error('A local Anvil Ethereum fork is required.')
    control.snapshot = await provider.send('evm_snapshot', [])
    control.signer = await provider.getSigner(0)
    const factory = new Contract(
      '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      ['function getPool(address,address,uint24) view returns(address)'],
      provider,
    )
    const holder = await factory.getFunction('getPool')(TOKENS.USDC.address, TOKENS.WETH.address, 500)
    await provider.send('anvil_impersonateAccount', [holder])
    await provider.send('anvil_setBalance', [holder, '0x56bc75e2d63100000'])
    const token = new Contract(TOKENS.USDC.address, ERC20, new JsonRpcSigner(provider, holder))
    await (await token.getFunction('transfer')(await control.signer.getAddress(), 1_000_000_000n)).wait()
    await provider.send('anvil_stopImpersonatingAccount', [holder])
  }, 60_000)
  afterAll(async () => {
    if (control.snapshot) await provider.send('evm_revert', [control.snapshot])
    provider.destroy()
  })

  it('executes the exact approvals, pool swap, fee and revocation', async () => {
    const signer = control.signer
    if (!signer) throw new Error('Missing fork signer')
    const account = await signer.getAddress()
    const quote = await quoteSwap(provider, 'USDC', '100', account)
    const usdc = new Contract(TOKENS.USDC.address, ERC20, provider)
    const weth = new Contract(TOKENS.WETH.address, ERC20, provider)
    const beforeFee: bigint = await weth.getFunction('balanceOf')(OPHIS_FEE.recipient)
    const beforeBuy: bigint = await weth.getFunction('balanceOf')(account)
    for (const call of quote.calls) await (await signer.sendTransaction(call)).wait()
    const received: bigint = (await weth.getFunction('balanceOf')(account)) - beforeBuy
    const paidFee: bigint = (await weth.getFunction('balanceOf')(OPHIS_FEE.recipient)) - beforeFee
    expect(received).toBeGreaterThanOrEqual(quote.minimum)
    expect(paidFee).toBe((received + paidFee) / 10_000n)
    const approval = ERC20.decodeFunctionData('approve', quote.calls[0].data)[0]
    expect(await usdc.getFunction('allowance')(account, approval)).toBe(0n)
  }, 60_000)

  it('rejects an unattainable minimum output at the pool', async () => {
    const signer = control.signer
    if (!signer) throw new Error('Missing fork signer')
    const calls = recipeCalls(
      'USDC',
      'WETH',
      await signer.getAddress(),
      1_000_000n,
      2n ** 100n,
      Math.floor(Date.now() / 1000) + 120,
    )
    await (await signer.sendTransaction(calls[0])).wait()
    await (await signer.sendTransaction(calls[1])).wait()
    const output = new Contract(TOKENS.WETH.address, ERC20, provider)
    const feeBefore = await output.getFunction('balanceOf')(OPHIS_FEE.recipient)
    const failed = await signer.sendTransaction({ ...calls[2], gasLimit: 1_500_000n })
    await expect(failed.wait()).rejects.toThrow()
    for (const cleanup of calls.slice(3)) await (await signer.sendTransaction(cleanup)).wait()
    expect(await output.getFunction('balanceOf')(OPHIS_FEE.recipient)).toBe(feeBefore)
  }, 30_000)
})
