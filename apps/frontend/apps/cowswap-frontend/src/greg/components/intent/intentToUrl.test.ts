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

  it('full intent: amount + chain + sell + buy → URL', () => {
    const url = intentToUrl(
      make([
        { type: 'amount', value: '100', raw: '100', start: 5, end: 8 },
        { type: 'sellToken', value: 'USDC', raw: 'usdc', start: 9, end: 13 },
        { type: 'buyToken', value: 'ETH', raw: 'eth', start: 18, end: 21 },
        { type: 'chain', value: 'optimism', raw: 'optimism', start: 25, end: 33 },
      ]),
    )
    // amount intentionally not encoded (per-token decimals scaling deferred to V2)
    expect(url).toBe('/10/swap/USDC/ETH')
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
