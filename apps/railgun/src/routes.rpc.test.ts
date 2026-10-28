import { afterAll, describe, expect, it, vi } from 'vitest'
import { Contract, JsonRpcProvider, isError, parseUnits } from 'ethers'
import { CHAIN_ID, QUOTE, QUOTER, SELECTED_NETWORK, TOKENS, type TokenSymbol } from './config'
import { MULTICALL3, quoteBestRoute, routeCandidates } from './routes'

// Read-only integration check: no wallet, approvals or transaction submission.
describe.skipIf(process.env.RAILGUN_RPC_QUOTE_TEST !== '1')(`${SELECTED_NETWORK.name} aggregate route quotes`, () => {
  const provider = new JsonRpcProvider(process.env.RAILGUN_RPC_URL, CHAIN_ID, { batchMaxCount: 1 })
  afterAll(() => provider.destroy())

  it('keeps direct and intermediate routes in one bounded call with the same quoted output', async () => {
    expect(Number((await provider.getNetwork()).chainId)).toBe(CHAIN_ID)
    expect(await provider.getCode(MULTICALL3)).not.toBe('0x')
    const call = vi.spyOn(provider, 'call')
    try {
      for (const sell of Object.keys(TOKENS) as TokenSymbol[]) {
        for (const buy of Object.keys(TOKENS) as TokenSymbol[]) {
          if (sell === buy) continue
          call.mockClear()
          const amount = parseUnits(sell === SELECTED_NETWORK.wrappedSymbol ? '0.001' : '1', TOKENS[sell].decimals)
          const best = await quoteBestRoute(provider, sell, buy, amount)
          expect(call).toHaveBeenCalledOnce()
          const aggregate = call.mock.calls[0][0]
          expect(aggregate.to).toBe(MULTICALL3)
          expect(aggregate.gasLimit).toBe(30_000_000n)
          const direct = await new Contract(QUOTER, QUOTE, provider).getFunction('quoteExactInput').staticCall(
            best.route.path, amount, { blockTag: aggregate.blockTag, gasLimit: 30_000_000n },
          )
          expect(best.amountOut).toBe(BigInt(direct[0]))
          expect(best.availableRoutes).toBeGreaterThan(0)
          expect(best.availableRoutes).toBeLessThanOrEqual(20)
          console.log(JSON.stringify({ chainId: CHAIN_ID, sell, buy, block: aggregate.blockTag, candidates: 20, availableRoutes: best.availableRoutes, quoteCalls: 1, sameBlockOutputMatch: true }))
          await new Promise((resolve) => setTimeout(resolve, 1200))
        }
      }
    } finally { call.mockRestore() }
  }, 120_000)

  it.skipIf(CHAIN_ID !== 1)('matches all individual candidates for a representative large Ethereum quote', async () => {
    const amount = parseUnits('1000000', TOKENS.USDC.decimals)
    const call = vi.spyOn(provider, 'call')
    try {
      const best = await quoteBestRoute(provider, 'USDC', 'WETH', amount)
      const blockTag = call.mock.calls[0][0].blockTag
      const outputs: bigint[] = []
      const quoter = new Contract(QUOTER, QUOTE, provider)
      for (const route of routeCandidates('USDC', 'WETH')) {
        try {
          const quote = await quoter.getFunction('quoteExactInput').staticCall(route.path, amount, { blockTag, gasLimit: 30_000_000n })
          if (BigInt(quote[0]) > 0n) outputs.push(BigInt(quote[0]))
        } catch (error) {
          if (!isError(error, 'CALL_EXCEPTION')) throw error
        }
      }
      expect(best.amountOut).toBe(outputs.reduce((max, output) => output > max ? output : max, 0n))
      expect(best.availableRoutes).toBe(outputs.length)
    } finally { call.mockRestore() }
  }, 120_000)
})
