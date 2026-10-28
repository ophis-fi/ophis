import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Contract, JsonRpcProvider, JsonRpcSigner, parseUnits } from 'ethers'
import { CHAIN_ID, ERC20, OPHIS_FEE, SELECTED_NETWORK, TOKENS, WRAPPED_SYMBOL } from './config'
import { quoteSwap, recipeCalls } from './recipe'
import { V3_FEES } from './routes'

const enabled = process.env.RAILGUN_FORK_TEST === '1'
const forkUrl = new URL(process.env.RAILGUN_FORK_RPC_URL || 'http://127.0.0.1:8549')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(forkUrl.hostname)) throw new Error('Fork tests require loopback RPC.')
const provider = new JsonRpcProvider(forkUrl.href, CHAIN_ID)
const control: { snapshot?: string; signer?: JsonRpcSigner } = {}

describe.skipIf(!enabled)(`${SELECTED_NETWORK.name} fork: private-swap pool calls`, () => {
  beforeAll(async () => {
    const metadata = await provider.send('anvil_metadata', [])
    if (!metadata.forkedNetwork) throw new Error('A local Anvil fork is required.')
    control.snapshot = await provider.send('evm_snapshot', [])
    control.signer = await provider.getSigner(0)
    const factory = new Contract(
      SELECTED_NETWORK.factory,
      ['function getPool(address,address,uint24) view returns(address)'],
      provider,
    )
    const usdc = new Contract(TOKENS.USDC.address, ERC20, provider)
    const funding = parseUnits('100', TOKENS.USDC.decimals)
    let holder: string | undefined
    for (const other of Object.values(TOKENS).filter((token) => token.symbol !== 'USDC')) {
      for (const fee of V3_FEES) {
        const candidate: string = await factory.getFunction('getPool')(TOKENS.USDC.address, other.address, fee)
        if (candidate !== '0x0000000000000000000000000000000000000000' && await usdc.getFunction('balanceOf')(candidate) >= funding) {
          holder = candidate
          break
        }
      }
      if (holder) break
    }
    if (!holder) throw new Error('No sufficiently funded local-fork pool was found.')
    await provider.send('anvil_impersonateAccount', [holder])
    await provider.send('anvil_setBalance', [holder, '0x56bc75e2d63100000'])
    const token = new Contract(TOKENS.USDC.address, ERC20, new JsonRpcSigner(provider, holder))
    await (await token.getFunction('transfer')(await control.signer.getAddress(), funding)).wait()
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
    const quote = await quoteSwap(provider, 'USDC', '10', account)
    const usdc = new Contract(TOKENS.USDC.address, ERC20, provider)
    const weth = new Contract(TOKENS[WRAPPED_SYMBOL].address, ERC20, provider)
    const beforeFee: bigint = await weth.getFunction('balanceOf')(OPHIS_FEE.recipient)
    const beforeBuy: bigint = await weth.getFunction('balanceOf')(account)
    for (const call of quote.calls) await (await signer.sendTransaction(call)).wait()
    const received: bigint = (await weth.getFunction('balanceOf')(account)) - beforeBuy
    const paidFee: bigint = (await weth.getFunction('balanceOf')(OPHIS_FEE.recipient)) - beforeFee
    expect(received).toBeGreaterThanOrEqual(quote.minimum)
    expect(paidFee).toBe(((received + paidFee) * 10n) / 10_000n)
    const approval = ERC20.decodeFunctionData('approve', quote.calls[0].data)[0]
    expect(await usdc.getFunction('allowance')(account, approval)).toBe(0n)
  }, 60_000)

  it('executes a stablecoin pool route and its reverse with the same fee policy', async () => {
    const signer = control.signer
    if (!signer) throw new Error('Missing fork signer')
    const account = await signer.getAddress()
    for (const [sell, buy, amount] of [['USDC', 'USDT', '10'], ['USDT', 'USDC', '1']] as const) {
      const quote = await quoteSwap(provider, sell, amount, account, buy)
      const output = new Contract(TOKENS[buy].address, ERC20, provider)
      const before = await output.getFunction('balanceOf')(account)
      const beforeFee = await output.getFunction('balanceOf')(OPHIS_FEE.recipient)
      for (const call of quote.calls) await (await signer.sendTransaction(call)).wait()
      const received = BigInt(await output.getFunction('balanceOf')(account)) - BigInt(before)
      const paidFee = BigInt(await output.getFunction('balanceOf')(OPHIS_FEE.recipient)) - BigInt(beforeFee)
      expect(received).toBeGreaterThanOrEqual(quote.minimum)
      expect(paidFee).toBe(((received + paidFee) * 10n) / 10_000n)
    }
  }, 60_000)

  it('rejects an unattainable minimum output at the pool', async () => {
    const signer = control.signer
    if (!signer) throw new Error('Missing fork signer')
    const calls = recipeCalls(
      'USDC',
      WRAPPED_SYMBOL,
      await signer.getAddress(),
      parseUnits('1', TOKENS.USDC.decimals),
      2n ** 100n,
      Math.floor(Date.now() / 1000) + 120,
    )
    await (await signer.sendTransaction(calls[0])).wait()
    await (await signer.sendTransaction(calls[1])).wait()
    const output = new Contract(TOKENS[WRAPPED_SYMBOL].address, ERC20, provider)
    const feeBefore = await output.getFunction('balanceOf')(OPHIS_FEE.recipient)
    const failed = await signer.sendTransaction({ ...calls[2], gasLimit: 1_500_000n })
    await expect(failed.wait()).rejects.toThrow()
    for (const cleanup of calls.slice(3)) await (await signer.sendTransaction(cleanup)).wait()
    expect(await output.getFunction('balanceOf')(OPHIS_FEE.recipient)).toBe(feeBefore)
  }, 30_000)
})
