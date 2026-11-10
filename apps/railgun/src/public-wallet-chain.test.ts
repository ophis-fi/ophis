import { expect, it, vi } from 'vitest'
import { BrowserProvider, Wallet, type Eip1193Provider } from 'ethers'
import { CHAIN } from './config'
import { approveExactShieldToken } from './shield'

it.each(['before-check', 'after-check'])('binds the actual wallet approval across a network switch %s', async timing => {
  const account = Wallet.createRandom().address
  let activeChain = CHAIN
  const submitted: Record<string, string>[] = []
  const wallet: Eip1193Provider = { request: async ({ method, params }) => {
    const values = params as Record<string, string>[]
    if (method === 'eth_chainId') return `0x${activeChain.toString(16)}`
    if (method === 'eth_accounts') return [account]
    if (method === 'eth_call') return `0x${(values[0].data.startsWith('0x095ea7b3') ? '1' : '0').padStart(64, '0')}`
    if (method === 'eth_blockNumber') return '0x1'
    if (method === 'eth_estimateGas') return '0x10000'
    if (method === 'eth_sendTransaction') {
      submitted.push(values[0])
      throw Object.assign(new Error('Dummy wallet rejected before signing'), { code: 4001 })
    }
    throw new Error(`Unexpected dummy wallet method ${method}`)
  } }
  const provider = new BrowserProvider(wallet, undefined, { cacheTimeout: -1 })
  try {
    const signer = await provider.getSigner()
    const change = () => { activeChain = CHAIN === 1n ? 56n : 1n }
    await expect(approveExactShieldToken(signer, 'USDC', 1n, async () => {
      if ((await provider.getNetwork()).chainId !== CHAIN) throw new Error('Network changed')
      if (timing === 'after-check') change()
    }, message => { if (timing === 'before-check' && message.startsWith('Confirm the')) change() }))
      .rejects.toThrow(/changed|rejected/)
    if (timing === 'before-check') expect(submitted).toEqual([])
    else {
      expect(submitted).toHaveLength(1)
      expect(submitted[0].chainId).toBe(`0x${CHAIN.toString(16)}`)
      expect(submitted[0].from.toLowerCase()).toBe(account.toLowerCase())
    }
  } finally { provider.destroy() }
})
