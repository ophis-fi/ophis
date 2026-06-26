/**
 * Unit tests for the /api/trending sanitization layer.
 *
 * These guard the CF Pages Function `functions/api/trending.ts`. GeckoTerminal's
 * response is UNTRUSTED: anyone can deploy a token and have it indexed with an
 * attacker-chosen symbol, name, address, and image_url, and if it trends those
 * fields reach the swap UI. `parseTrending` + `safeLogoUrl` are the SOLE filter
 * between that upstream and the panel, so this harness is load-bearing — it must
 * prove a malicious payload is stripped (bad/missing address dropped; logo URL
 * pinned to https + trusted host, defeating CSS/markup injection and the
 * third-party privacy beacon).
 *
 * Run (Node 22+, no test framework needed):
 *   node --experimental-strip-types --test tests/functions/trending-validation.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTrending, safeLogoUrl } from '../../functions/api/trending.ts'

const GECKO_LOGO = 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png'

// --- safeLogoUrl: only https on a CoinGecko/GeckoTerminal host survives ---

test('logo: a real CoinGecko CDN https url is kept', () => {
  assert.equal(safeLogoUrl(GECKO_LOGO), GECKO_LOGO)
  assert.equal(safeLogoUrl('https://assets.geckoterminal.com/x/y.png'), 'https://assets.geckoterminal.com/x/y.png')
})

test('logo: CSS-breakout payloads are rejected (never reach a style)', () => {
  // The classic background-image: url(...) breakout — must not survive.
  assert.equal(safeLogoUrl('https://coin-images.coingecko.com/a.png);background:url(https://evil.tld/x'), null)
  assert.equal(safeLogoUrl('https://evil.tld/x.png'), null) // untrusted host
  assert.equal(safeLogoUrl("https://coin-images.coingecko.com/a.png'"), null) // trusted host but a quote -> char filter rejects
})

test('logo: non-https schemes are rejected', () => {
  assert.equal(safeLogoUrl('http://coin-images.coingecko.com/a.png'), null)
  assert.equal(safeLogoUrl('javascript:alert(1)'), null)
  assert.equal(safeLogoUrl('data:image/svg+xml,<svg onload=alert(1)>'), null)
})

test('logo: host-suffix spoofing and userinfo tricks are defeated', () => {
  assert.equal(safeLogoUrl('https://evilcoingecko.com/a.png'), null) // no leading dot -> not a real subdomain
  assert.equal(safeLogoUrl('https://coin-images.coingecko.com.evil.tld/a.png'), null) // suffix is evil.tld
  assert.equal(safeLogoUrl('https://coin-images.coingecko.com@evil.tld/a.png'), null) // hostname parses to evil.tld
  assert.equal(safeLogoUrl('https://evil.tld@coin-images.coingecko.com/a.png'), null) // userinfo rejected even when host is trusted
})

test('logo: missing/empty placeholders become null', () => {
  assert.equal(safeLogoUrl(undefined), null)
  assert.equal(safeLogoUrl(''), null)
  assert.equal(safeLogoUrl('https://coin-images.coingecko.com/missing_small.png'), null)
})

// --- parseTrending: end-to-end on a crafted malicious GeckoTerminal payload ---

function pool(tokenId: string, price = '1.5', liq = '50000', h1 = '12.3') {
  return {
    attributes: { base_token_price_usd: price, reserve_in_usd: liq, price_change_percentage: { h1 } },
    relationships: { base_token: { data: { id: tokenId } } },
  }
}

test('parse: malicious token fields are sanitized end-to-end', () => {
  const GOOD = '0x' + 'a'.repeat(40)
  const raw = {
    data: [pool('t-good'), pool('t-badaddr'), pool('t-badlogo')],
    included: [
      { id: 't-good', attributes: { address: GOOD, symbol: 'PEPE', name: 'Pepe', image_url: GECKO_LOGO } },
      // address is not a 0x-40hex -> the whole token must be dropped.
      { id: 't-badaddr', attributes: { address: 'not-an-address', symbol: 'EVIL', name: 'Evil', image_url: GECKO_LOGO } },
      // valid address but a CSS-injection logo on an untrusted host -> logo nulled, token kept.
      {
        id: 't-badlogo',
        attributes: {
          address: '0x' + 'b'.repeat(40),
          symbol: 'USDC', // impersonation symbol is allowed text (React-escaped) but logo must be safe
          name: 'definitely usdc',
          image_url: 'https://evil.tld/x.png);background:url(https://evil.tld/beacon',
        },
      },
    ],
  }
  const out = parseTrending(raw)
  // The bad-address token is gone entirely.
  assert.equal(out.find((t) => t.symbol === 'EVIL'), undefined)
  // The good token keeps its trusted logo.
  const good = out.find((t) => t.address === GOOD)
  assert.ok(good)
  assert.equal(good?.logo, GECKO_LOGO)
  // The impersonation token is present (text is safe to render) but its hostile logo is stripped.
  const badlogo = out.find((t) => t.address === '0x' + 'b'.repeat(40))
  assert.ok(badlogo)
  assert.equal(badlogo?.logo, null)
})

test('parse: low-liquidity and non-finite price rows are filtered', () => {
  const raw = {
    data: [pool('t-lowliq', '1', '100'), pool('t-nan', 'abc', '99999'), pool('t-ok', '2', '999999')],
    included: [
      { id: 't-lowliq', attributes: { address: '0x' + '1'.repeat(40), symbol: 'LOW', name: 'Low' } },
      { id: 't-nan', attributes: { address: '0x' + '2'.repeat(40), symbol: 'NAN', name: 'Nan' } },
      { id: 't-ok', attributes: { address: '0x' + '3'.repeat(40), symbol: 'OK', name: 'Ok' } },
    ],
  }
  const out = parseTrending(raw)
  assert.deepEqual(
    out.map((t) => t.symbol),
    ['OK'],
  )
})

test('parse: empty / malformed upstream yields an empty list, never throws', () => {
  assert.deepEqual(parseTrending({}), [])
  assert.deepEqual(parseTrending(null), [])
  assert.deepEqual(parseTrending({ data: [], included: [] }), [])
})

test('parse: non-string token fields never throw (no isolate crash)', () => {
  // A real upstream can surface a token whose symbol/name/image_url/address is not
  // a string; none of these may reach .slice()/.includes() and throw.
  const raw = {
    data: [pool('t-weird'), pool('t-ok')],
    included: [
      { id: 't-weird', attributes: { address: 12345, symbol: 99, name: { x: 1 }, image_url: 42 } },
      { id: 't-ok', attributes: { address: '0x' + 'c'.repeat(40), symbol: 'OK', name: 'Ok', image_url: GECKO_LOGO } },
    ],
  }
  let out: ReturnType<typeof parseTrending> = []
  assert.doesNotThrow(() => {
    out = parseTrending(raw)
  })
  // The weird token (non-string address) is dropped; the good one survives with a safe logo.
  assert.deepEqual(
    out.map((t) => t.symbol),
    ['OK'],
  )
  assert.equal(out[0]?.logo, GECKO_LOGO)
})
