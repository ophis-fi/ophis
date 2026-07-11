import { GECKO_NETWORK, parseTrending, safeLogoUrl } from './geckoTerminal'

const TOK_A = `0x${'a'.repeat(40)}`

const inc = (id: string, address: string, extra: Record<string, unknown> = {}) => ({
  id,
  attributes: { address, symbol: 'AAA', name: 'Token A', ...extra },
})
const pool = (baseId: string, attrs: Record<string, unknown> = {}) => ({
  attributes: { base_token_price_usd: '1.5', reserve_in_usd: '50000', price_change_percentage: { h1: '3.214' }, ...attrs },
  relationships: { base_token: { data: { id: baseId } } },
})

describe('safeLogoUrl', () => {
  it('allows https logos only on coingecko / geckoterminal hosts', () => {
    const ok = 'https://assets.coingecko.com/coins/images/1/large/x.png'
    expect(safeLogoUrl(ok)).toBe(ok)
    expect(safeLogoUrl('https://img.geckoterminal.com/x.png')).toBe('https://img.geckoterminal.com/x.png')
  })

  it('rejects non-https, untrusted hosts, suffix-spoofs, and userinfo tricks', () => {
    expect(safeLogoUrl('http://assets.coingecko.com/x.png')).toBeNull() // not https
    expect(safeLogoUrl('https://evil.com/x.png')).toBeNull() // untrusted host
    expect(safeLogoUrl('https://evilcoingecko.com/x.png')).toBeNull() // suffix spoof, no leading dot
    expect(safeLogoUrl('https://assets.coingecko.com@evil.com/x.png')).toBeNull() // host is evil.com
    expect(safeLogoUrl('https://user@assets.coingecko.com/x.png')).toBeNull() // userinfo present
  })

  it('rejects markup/CSS-dangerous chars, the "missing" placeholder, and non-strings', () => {
    expect(safeLogoUrl('https://assets.coingecko.com/x(1).png')).toBeNull() // '('
    expect(safeLogoUrl('https://assets.coingecko.com/x .png')).toBeNull() // space
    expect(safeLogoUrl('https://assets.coingecko.com/x".png')).toBeNull() // quote
    expect(safeLogoUrl('https://assets.coingecko.com/missing.png')).toBeNull() // "missing"
    expect(safeLogoUrl(null)).toBeNull()
    expect(safeLogoUrl(123)).toBeNull()
    expect(safeLogoUrl(undefined)).toBeNull()
    expect(safeLogoUrl('not a url')).toBeNull()
  })
})

describe('parseTrending', () => {
  it('parses a valid response into the panel token shape', () => {
    const out = parseTrending({
      data: [pool('t1')],
      included: [inc('t1', TOK_A, { image_url: 'https://assets.coingecko.com/a.png' })],
    })
    expect(out).toEqual([
      { symbol: 'AAA', name: 'Token A', address: TOK_A, priceUsd: 1.5, change1h: 3.21, logo: 'https://assets.coingecko.com/a.png' },
    ])
  })

  it('excludes low-liquidity (< $20k) and non-positive-price pools', () => {
    expect(parseTrending({ data: [pool('t1', { reserve_in_usd: '1000' })], included: [inc('t1', TOK_A)] })).toEqual([])
    expect(parseTrending({ data: [pool('t1', { base_token_price_usd: '0' })], included: [inc('t1', TOK_A)] })).toEqual([])
  })

  it('drops tokens with a non-0x40hex address (the address is a swap navigation target)', () => {
    expect(parseTrending({ data: [pool('t1')], included: [inc('t1', '0xBAD')] })).toEqual([])
  })

  it('nulls an untrusted logo host but keeps the token', () => {
    const [t] = parseTrending({ data: [pool('t1')], included: [inc('t1', TOK_A, { image_url: 'https://evil.com/x.png' })] })
    expect(t?.logo).toBeNull()
    expect(t?.address).toBe(TOK_A)
  })

  it('fails soft to [] on malformed / non-object input (never throws)', () => {
    expect(parseTrending(null)).toEqual([])
    expect(parseTrending('nope')).toEqual([])
    expect(parseTrending(42)).toEqual([])
    expect(parseTrending({})).toEqual([])
    expect(parseTrending({ data: [pool('missing')], included: [] })).toEqual([]) // pool refs a token not present
    // non-array data/included, or null entries, must NOT throw (Codex review)
    expect(parseTrending({ included: {}, data: [] })).toEqual([])
    expect(parseTrending({ included: [null], data: [] })).toEqual([])
    expect(parseTrending({ data: {} })).toEqual([])
    expect(parseTrending({ data: [null], included: [] })).toEqual([])
  })

  it('coerces non-string symbol/name without throwing', () => {
    const [t] = parseTrending({ data: [pool('t1')], included: [inc('t1', TOK_A, { symbol: 123, name: null })] })
    expect(t?.symbol).toBe('123')
    expect(t?.name).toBe('123') // name null -> falls back to symbol
  })

  it('dedups the same token across pools and caps at 6', () => {
    const dup = parseTrending({ data: [pool('t1'), pool('t1')], included: [inc('t1', TOK_A)] })
    expect(dup).toHaveLength(1)

    const many = parseTrending({
      data: Array.from({ length: 8 }, (_, i) => pool(`t${i}`)),
      included: Array.from({ length: 8 }, (_, i) => inc(`t${i}`, `0x${String(i).repeat(40).slice(0, 40)}`)),
    })
    expect(many.length).toBe(6)
  })
})

describe('GECKO_NETWORK', () => {
  it('maps the supported chains to GeckoTerminal slugs; others are undefined', () => {
    expect(GECKO_NETWORK[1]).toBe('eth')
    expect(GECKO_NETWORK[8453]).toBe('base')
    expect(GECKO_NETWORK[100]).toBe('xdai')
    expect(GECKO_NETWORK[999999]).toBeUndefined()
  })
})
