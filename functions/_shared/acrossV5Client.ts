import { acrossAddress, acrossAmount, acrossOrderId, type AcrossV5Quote, type AcrossV5Request } from './acrossV5'

export async function acrossV5Api(url: string, path: string, body?: AcrossV5Request): Promise<unknown> {
  const response = await fetch(url + '/' + path, {
    method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error('Across bridge is unavailable')
  return response.json()
}

export interface AcrossV5Token {
  chainId: number
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

export async function acrossV5Tokens(
  url: string,
  query: URLSearchParams,
  side: 'origin' | 'destination',
): Promise<AcrossV5Token[]> {
  const result: AcrossV5Token[] = []
  const params = new URLSearchParams(query)
  const cursorKey = side + 'Cursor'
  const seen = new Set<string>()
  for (;;) {
    const data = (await acrossV5Api(url, 'capabilities?' + params)) as {
      originTokens?: unknown
      destinationTokens?: unknown
      pagination?: Record<string, { nextCursor?: string }>
    }
    const tokens = side === 'origin' ? data.originTokens : data.destinationTokens
    if (!Array.isArray(tokens)) throw new Error('Invalid Across capabilities')
    for (const item of tokens) {
      const token = item?.token ?? item
      if (
        Number.isSafeInteger(token?.chainId) && acrossAddress(token.address) &&
        typeof token.symbol === 'string' && typeof token.name === 'string' &&
        Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255
      ) {
        result.push({
          chainId: token.chainId, address: token.address, symbol: token.symbol, name: token.name,
          decimals: token.decimals, logoURI: typeof token.logoUrl === 'string' ? token.logoUrl : undefined,
        })
      }
    }
    const cursor = data.pagination?.[side]?.nextCursor
    if (!cursor) return result
    if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('Invalid Across pagination')
    seen.add(cursor)
    params.set(cursorKey, cursor)
  }
}

export interface AcrossV5Order {
  orderId: string
  originValidUntil: number
  amount: string
  minimumOutput: string
  recipient: string
}

export function readAcrossV5Order(body: string | undefined): AcrossV5Order | undefined {
  try {
    const meta = JSON.parse(body ?? '') as AcrossV5Order & { version?: number }
    if (
      meta?.version === 5 && acrossOrderId(meta.orderId) && Number.isSafeInteger(meta.originValidUntil) &&
      acrossAmount(meta.amount) && meta.amount !== '0' &&
      acrossAmount(meta.minimumOutput) && meta.minimumOutput !== '0' && acrossAddress(meta.recipient)
    ) return meta
  } catch {
    return undefined
  }
  return undefined
}

export function acrossV5Amounts(quote: AcrossV5Quote, requestAmount: bigint) {
  const buyAmount = BigInt(quote.expectedOutput)
  const gross = BigInt(quote.grossOutput)
  const min = BigInt(quote.minimumOutput)
  const fee = gross - buyAmount
  const input = BigInt(quote.amount)
  return {
    beforeFee: { sellAmount: requestAmount, buyAmount: gross },
    afterFee: { sellAmount: requestAmount, buyAmount },
    afterSlippage: { sellAmount: requestAmount, buyAmount: min },
    slippageBps: Number(((buyAmount - min) * 10_000n) / buyAmount),
    costs: { bridgingFee: {
      feeBps: Number((fee * 10_000n) / input),
      amountInSellCurrency: fee,
      amountInBuyCurrency: fee,
    } },
  }
}

// Shared SDK quote fields. The actual source debit is in metadata, separate from order output.
export function acrossV5BridgeQuote(quote: AcrossV5Quote, requestAmount: bigint, recipient: string) {
  const amountsAndCosts = acrossV5Amounts(quote, requestAmount)
  return {
    id: quote.orderId,
    isSell: true,
    quoteTimestamp: Math.floor(Date.now() / 1000),
    amountsAndCosts,
    quoteBody: JSON.stringify({
      version: 5, orderId: quote.orderId, originValidUntil: quote.originValidUntil,
      amount: quote.amount, minimumOutput: quote.minimumOutput, recipient,
    }),
    expectedFillTimeSeconds: quote.expectedFillTimeMs === undefined ? undefined : quote.expectedFillTimeMs / 1000,
    fees: { bridgeFee: amountsAndCosts.costs.bridgingFee.amountInSellCurrency, destinationGasFee: 0n },
    limits: { minDeposit: BigInt(quote.amount), maxDeposit: BigInt(quote.amount) },
  }
}
