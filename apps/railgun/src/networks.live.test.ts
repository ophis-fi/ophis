import { afterEach, describe, expect, it, vi } from 'vitest'
import { Contract, FetchRequest, JsonRpcProvider } from 'ethers'
import { PRIVATE_NETWORKS } from './networks'
import type { WalletSession } from './wallet'

const enabled = process.env.RAILGUN_LIVE_READ === '1'
const rpc: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
}
afterEach(() => vi.unstubAllGlobals())

describe.skipIf(!enabled).each(PRIVATE_NETWORKS)('$name read-only deployed routes', (network) => {
  it('verifies deployed code, token precision, factory and a live quote without sending transactions', async () => {
    vi.resetModules()
    vi.stubGlobal('location', new URL(`http://localhost/?chainId=${network.chainId}`))
    const config = await import('./config')
    const { quoteSwap } = await import('./recipe')
    const { gasDetails, minimumGasPrice } = await import('./broadcaster')
    const request = new FetchRequest(rpc[network.chainId])
    request.timeout = 15_000
    const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 })
    try {
      expect(Number((await provider.getNetwork()).chainId)).toBe(network.chainId)
      const session = { provider } as WalletSession
      const gas = await gasDetails(session)
      expect(gas.maxFeePerGas).toBeGreaterThan(0n)
      expect(gas.maxPriorityFeePerGas).toBeLessThanOrEqual(gas.maxFeePerGas)
      expect(await minimumGasPrice(session, gas)).toBeGreaterThan(0n)
      const addresses = [network.router, network.quoter, network.factory, config.PERMIT2, config.CONFIG.proxyContract]
      expect((await Promise.all(addresses.map((address) => provider.getCode(address)))).every((code) => code !== '0x')).toBe(true)
      const quoter = new Contract(network.quoter, ['function factory() view returns(address)'], provider)
      expect((await quoter.getFunction('factory')()).toLowerCase()).toBe(network.factory.toLowerCase())
      for (const token of Object.values(config.TOKENS)) {
        const contract = new Contract(token.address, ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'], provider)
        expect(Number(await contract.getFunction('decimals')())).toBe(token.decimals)
        expect(await contract.getFunction('symbol')()).toBeTruthy()
      }
      const quote = await quoteSwap(provider, 'USDC', '10', '0x0000000000000000000000000000000000001234')
      expect(quote.expected).toBeGreaterThan(0n)
      expect(quote.ophisFee).toBe(((quote.expected + quote.ophisFee) * 10n) / 10_000n)
      expect(quote.chainId).toBe(network.chainId)
      expect(quote.route?.fees.length).toBeGreaterThan(0)
      const stableQuote = await quoteSwap(provider, 'USDT', '10', '0x0000000000000000000000000000000000001234', 'USDC')
      expect(stableQuote.expected).toBeGreaterThan(0n)
      expect(quote.availableRoutes).toBeGreaterThan(1)
      console.info(JSON.stringify({ network: network.name, route: quote.route?.tokens, fees: quote.route?.fees, availableRoutes: quote.availableRoutes, stableRoutes: stableQuote.availableRoutes }))
    } finally { provider.destroy() }
  }, 45_000)
})
