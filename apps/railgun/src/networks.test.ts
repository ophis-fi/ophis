import { afterEach, describe, expect, it, vi } from 'vitest'
import { AbiCoder, type JsonRpcProvider } from 'ethers'
import { PRIVATE_NETWORKS, privateNetwork } from './networks'
import type { SwapQuote } from './recipe'

afterEach(() => vi.unstubAllGlobals())

describe.each(PRIVATE_NETWORKS)('$name private swap configuration', (network) => {
  it('binds amounts, pool routes, fee and quotes to the selected chain', async () => {
    vi.resetModules()
    vi.stubGlobal('location', new URL(`http://localhost/?chainId=${network.chainId}`))
    const config = await import('./config')
    const { amountFromInput, recipeCalls, assertQuoteFresh, quoteSwap } = await import('./recipe')
    const { routeCandidates } = await import('./routes')
    expect(config.CHAIN).toBe(BigInt(network.chainId))
    expect(Object.keys(config.TOKENS)).toHaveLength(3)
    const precision = network.chainId === 56 ? 18 : 6
    expect(amountFromInput('1', 'USDC')).toBe(10n ** BigInt(precision))
    expect(config.tokenFor(config.WRAPPED_SYMBOL).address).toBe(config.CONFIG.baseToken.wrappedAddress)
    for (const sell of Object.keys(config.TOKENS).filter(config.isTokenSymbol)) {
      for (const buy of Object.keys(config.TOKENS).filter(config.isTokenSymbol).filter((token) => token !== sell)) {
        const candidates = routeCandidates(sell, buy)
        expect(candidates).toHaveLength(20)
        expect(new Set(candidates.map((route) => route.path)).size).toBe(20)
        for (const route of candidates) {
          const calls = recipeCalls(sell, buy, '0x0000000000000000000000000000000000001234', 100n, 1n, 12345, route.path)
          expect(calls[2].to).toBe(network.router)
          const [commands, inputs] = config.SWAP.decodeFunctionData('execute', calls[2].data)
          expect(commands.slice(2).match(/../g)?.filter((command: string) => command === '06')).toHaveLength(1)
          expect(AbiCoder.defaultAbiCoder().decode(['address', 'uint256', 'uint256', 'bytes', 'bool'], inputs[0])[3]).toBe(route.path)
          const fee = AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256'], inputs[1])
          expect(fee[0].toLowerCase()).toBe(config.tokenFor(buy).address.toLowerCase())
          expect(fee[1].toLowerCase()).toBe(config.OPHIS_FEE.recipient.toLowerCase())
          expect(fee[2]).toBe(10n)
          if (route.tokens.length === 3)
            expect(AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256'], inputs[4])[0].toLowerCase()).toBe(config.tokenFor(route.tokens[1]).address.toLowerCase())
        }
      }
    }
    expect(() => config.tokenFor('unsupported')).toThrow(/not supported/)
    const account = '0x0000000000000000000000000000000000001234'
    const quote = { account, chainId: network.chainId === 1 ? 56 : 1, deadline: Date.now() / 1000 + 120 } as SwapQuote
    expect(() => assertQuoteFresh(quote, account)).toThrow(/network changed/)
    const wrongRpc = { getNetwork: async () => ({ chainId: network.chainId === 1 ? 56n : 1n }) } as unknown as JsonRpcProvider
    await expect(quoteSwap(wrongRpc, 'USDC', '1', account)).rejects.toThrow(/RPC required/)
  })
})

it('rejects unsupported chains rather than using Ethereum as a fallback', () => {
  for (const value of [0, 10, 8453, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => privateNetwork(value)).toThrow()
})
