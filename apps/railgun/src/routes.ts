import { Contract, isError, solidityPacked, type JsonRpcProvider } from 'ethers'
import { QUOTE, QUOTER, TOKENS, isTokenSymbol, tokenFor, type TokenSymbol } from './config'

export const V3_FEES = [100, 500, 3000, 10_000] as const
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
  const quoter = new Contract(QUOTER, QUOTE, provider)
  const blockTag = await provider.getBlockNumber()
  const results = await Promise.allSettled(candidates.map(async (route) => {
    const result = await quoter.getFunction('quoteExactInput').staticCall(route.path, amount, { blockTag })
    return { route, amountOut: BigInt(result[0]), gasEstimate: BigInt(result[3]) }
  }))
  let best: { route: PrivateRoute; amountOut: bigint; gasEstimate: bigint } | undefined
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value.amountOut <= 0n) continue
    const value = result.value
    if (!best || value.amountOut > best.amountOut || (value.amountOut === best.amountOut && value.gasEstimate < best.gasEstimate))
      best = value
  }
  if (!best) {
    if (results.some((result) => result.status === 'rejected' && !isError(result.reason, 'CALL_EXCEPTION')))
      throw new Error('Route quotes are unavailable from this RPC. Retry after it recovers.')
    throw new Error('No supported pool route has liquidity for this pair and amount.')
  }
  return { ...best, availableRoutes: results.filter((result) => result.status === 'fulfilled' && result.value.amountOut > 0n).length }
}
