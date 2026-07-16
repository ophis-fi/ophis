import { intentToUrl } from './intentToUrl'
import type { ParsedIntent } from './types'

const make = (entities: ParsedIntent['entities']): ParsedIntent => ({ intent: 'swap', entities })

describe('intentToUrl', () => {
  it('returns /swap when intent is unknown', () => {
    expect(intentToUrl({ intent: 'unknown', entities: [] })).toBe('/swap')
  })

  it('builds chain segment when chain entity is present', () => {
    const url = intentToUrl(
      make([
        { type: 'chain', value: 'base', raw: 'Base', start: 0, end: 4 },
        { type: 'sellToken', value: 'USDC', raw: 'USDC', start: 5, end: 9 },
      ]),
    )
    expect(url).toBe('/8453/swap/USDC')
  })

  it('uses _ placeholder when only buy token is present', () => {
    const url = intentToUrl(
      make([
        { type: 'chain', value: 'ethereum', raw: 'Ethereum', start: 0, end: 8 },
        { type: 'buyToken', value: 'ETH', raw: 'ETH', start: 9, end: 12 },
      ]),
    )
    expect(url).toBe('/1/swap/_/ETH')
  })

  it('omits chain when not extracted (cowswap defaults to wallet chain)', () => {
    const url = intentToUrl(
      make([
        { type: 'sellToken', value: 'USDC', raw: 'USDC', start: 0, end: 4 },
        { type: 'buyToken', value: 'ETH', raw: 'ETH', start: 5, end: 8 },
      ]),
    )
    expect(url).toBe('/swap/USDC/ETH')
  })

  it('full intent: amount + chain + sell + buy → URL with human sell amount', () => {
    const url = intentToUrl(
      make([
        { type: 'amount', value: '100', raw: '100', start: 5, end: 8 },
        { type: 'sellToken', value: 'USDC', raw: 'usdc', start: 9, end: 13 },
        { type: 'buyToken', value: 'ETH', raw: 'eth', start: 18, end: 21 },
        { type: 'chain', value: 'optimism', raw: 'optimism', start: 25, end: 33 },
      ]),
    )
    // Amount is HUMAN units (not atomic): cowswap's useSetupTradeAmountsFromUrl
    // scales it by the token decimals via tryParseCurrencyAmount.
    expect(url).toBe('/10/swap/USDC/ETH?sellAmount=100')
  })

  it('buy-only intent fills buyAmount', () => {
    const url = intentToUrl(
      make([
        { type: 'amount', value: '500', raw: '500', start: 4, end: 7 },
        { type: 'buyToken', value: 'COW', raw: 'cow', start: 8, end: 11 },
      ]),
    )
    expect(url).toBe('/swap/_/COW?buyAmount=500')
  })

  it('amount with no token is dropped (nothing to bind it to)', () => {
    const url = intentToUrl(make([{ type: 'amount', value: '100', raw: '100', start: 0, end: 3 }]))
    expect(url).toBe('/swap')
  })

  it('sell amount survives token->address resolution', () => {
    const USDC = '0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48'
    const url = intentToUrl(
      make([
        { type: 'amount', value: '100', raw: '100', start: 0, end: 3 },
        { type: 'sellToken', value: 'USDC', raw: 'usdc', start: 4, end: 8 },
      ]),
      (s) => (s === 'USDC' ? USDC : null),
    )
    expect(url).toBe(`/swap/${USDC}?sellAmount=100`)
  })

  it('unknown chain slug is dropped', () => {
    const url = intentToUrl(
      make([
        { type: 'chain', value: 'something-fake', raw: 'fake', start: 0, end: 4 },
        { type: 'sellToken', value: 'USDC', raw: 'USDC', start: 5, end: 9 },
      ]),
    )
    expect(url).toBe('/swap/USDC')
  })

  it('only chain extracted → bare chain swap path', () => {
    const url = intentToUrl(make([{ type: 'chain', value: 'base', raw: 'base', start: 0, end: 4 }]))
    expect(url).toBe('/8453/swap')
  })
})

describe('intentToUrl with a token resolver', () => {
  const USDC_ADDR = '0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48'
  const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
  const resolve = (symbol: string): string | null =>
    (({ USDC: USDC_ADDR, ETH: ETH_SENTINEL }) as Record<string, string>)[symbol] ?? null

  it('emits resolved addresses in place of symbols', () => {
    const url = intentToUrl(
      make([
        { type: 'sellToken', value: 'USDC', raw: 'usdc', start: 0, end: 4 },
        { type: 'buyToken', value: 'ETH', raw: 'eth', start: 5, end: 8 },
      ]),
      resolve,
    )
    expect(url).toBe(`/swap/${USDC_ADDR}/${ETH_SENTINEL}`)
  })

  it('falls back to the bare symbol when the resolver returns null', () => {
    const url = intentToUrl(
      make([
        { type: 'sellToken', value: 'USDC', raw: 'usdc', start: 0, end: 4 },
        { type: 'buyToken', value: 'MOONPIG', raw: 'moonpig', start: 5, end: 12 },
      ]),
      resolve,
    )
    expect(url).toBe(`/swap/${USDC_ADDR}/MOONPIG`)
  })

  it('keeps the _ placeholder for a missing sell token', () => {
    const url = intentToUrl(make([{ type: 'buyToken', value: 'ETH', raw: 'eth', start: 0, end: 3 }]), resolve)
    expect(url).toBe(`/swap/_/${ETH_SENTINEL}`)
  })

  it('resolves alongside a chain segment', () => {
    const url = intentToUrl(
      make([
        { type: 'chain', value: 'base', raw: 'base', start: 0, end: 4 },
        { type: 'sellToken', value: 'USDC', raw: 'usdc', start: 5, end: 9 },
      ]),
      resolve,
    )
    expect(url).toBe(`/8453/swap/${USDC_ADDR}`)
  })
})
