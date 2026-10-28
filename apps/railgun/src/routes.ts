import { Contract, solidityPacked, type JsonRpcProvider } from 'ethers'
import { QUOTE, QUOTER, TOKENS, isTokenSymbol, tokenFor, type TokenSymbol } from './config'

export const V3_FEES = [100, 500, 3000, 10_000] as const
// Canonical deployment also pinned by packages/sdk/src/preflight.ts.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] results)']
// shortcut: direct and one-intermediate Uniswap v3 routes; add venues through validated adapters.
export interface PrivateRoute { path: string; tokens: TokenSymbol[]; fees: number[] }

export function routeCandidates(sell: TokenSymbol, buy: TokenSymbol): PrivateRoute[] {
  if (!isTokenSymbol(sell) || !isTokenSymbol(buy) || sell === buy) throw new Error('Choose two supported tokens.')
  const routes: PrivateRoute[] = []
  for (const fee of V3_FEES) {
    routes.push({
      path: solidityPacked(['address', 'uint24', 'address'], [tokenFor(sell).address, fee, tokenFor(buy).address]),
      tokens: [sell, buy], fees: [fee],
    })
  }
  for (const middle of Object.keys(TOKENS).filter(isTokenSymbol).filter((token) => token !== sell && token !== buy)) {
    for (const first of V3_FEES) for (const second of V3_FEES) {
      routes.push({
        path: solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'],
          [tokenFor(sell).address, first, tokenFor(middle).address, second, tokenFor(buy).address]),
        tokens: [sell, middle, buy], fees: [first, second],
      })
    }
  }
  return routes
}

export async function quoteBestRoute(provider: JsonRpcProvider, sell: TokenSymbol, buy: TokenSymbol, amount: bigint) {
  if (amount <= 0n) throw new Error('A positive route amount is required.')
  const candidates = routeCandidates(sell, buy)
  const blockTag = await provider.getBlockNumber()
  let results: ({ route: PrivateRoute; amountOut: bigint; gasEstimate: bigint } | undefined)[]
  try {
    // shortcut: candidates share 30m gas; split batches if large-trade quote coverage suffers.
    const response = await new Contract(MULTICALL3, MULTICALL, provider).getFunction('aggregate3').staticCall(
      candidates.map((route) => ({ target: QUOTER, allowFailure: true, callData: QUOTE.encodeFunctionData('quoteExactInput', [route.path, amount]) })),
      { blockTag, gasLimit: 30_000_000n },
    )
    if (response.length !== candidates.length) throw new Error('Incomplete route quote response.')
    results = candidates.map((route, index) => {
      if (!response[index].success) return undefined
      const result = QUOTE.decodeFunctionResult('quoteExactInput', response[index].returnData)
      return { route, amountOut: BigInt(result[0]), gasEstimate: BigInt(result[3]) }
    })
  } catch {
    throw new Error('Route quotes are unavailable from this RPC. Retry after it recovers.')
  }
  let best: { route: PrivateRoute; amountOut: bigint; gasEstimate: bigint } | undefined
  for (const value of results) {
    if (!value || value.amountOut <= 0n) continue
    if (!best || value.amountOut > best.amountOut || (value.amountOut === best.amountOut && value.gasEstimate < best.gasEstimate))
      best = value
  }
  if (!best) throw new Error('No supported pool route has liquidity for this pair and amount.')
  return { ...best, availableRoutes: results.filter((result) => result && result.amountOut > 0n).length }
}
