/**
 * Unit tests for the /api/intent recognition + injection-safety validators.
 *
 * These guard the CF Pages Function `functions/api/intent.ts`. The token
 * recognition gate was broadened (the hardcoded 236-symbol allow-list was
 * removed) so these validators are now the SOLE filter between the LLM and
 * the swap UI. That makes this harness load-bearing: it must prove that
 * broadening did NOT weaken the two real prompt-injection defenses
 * (raw-in-text + value-derives-from-raw) and that chains stay strictly gated.
 *
 * Run (Node 22+, no test framework needed):
 *   node --experimental-strip-types --test tests/functions/intent-recognition.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as intent from '../../functions/api/intent.ts'

type EntityType = 'sellToken' | 'buyToken' | 'amount' | 'chain'

// Build an entity with start/end offsets derived from where `raw` appears in
// `text` (isValidEntity only requires 0<=start<end<=len + raw-in-text, not an
// exact slice match, since the model's offsets are re-anchored client-side).
function ent(type: EntityType, value: string, raw: string, text: string) {
  const start = text.toLowerCase().indexOf(raw.toLowerCase())
  return {
    type,
    value,
    raw,
    start: start < 0 ? 0 : start,
    end: start < 0 ? raw.length : start + raw.length,
  }
}

// --- BROADENING: long-tail symbols the user actually typed are admitted ---

test('broaden: a long-tail token symbol the user typed is admitted', () => {
  const text = 'swap 100 grok for usdc'
  assert.equal(intent.isValidEntity(ent('sellToken', 'GROK', 'grok', text), text), true)
  assert.equal(intent.isValidEntity(ent('buyToken', 'USDC', 'usdc', text), text), true)
})

test('broaden: another long-tail symbol (MOONPIG) is admitted', () => {
  const text = 'buy moonpig with eth'
  assert.equal(intent.isValidEntity(ent('buyToken', 'MOONPIG', 'moonpig', text), text), true)
})

test('broaden: filterParsedIntent keeps a long-tail token end-to-end', () => {
  const text = 'swap eth for grok'
  const parsed = intent.filterParsedIntent(
    {
      intent: 'swap',
      entities: [ent('sellToken', 'ETH', 'eth', text), ent('buyToken', 'GROK', 'grok', text)],
    },
    text,
  )
  assert.deepEqual(
    parsed?.entities.map((e) => e.value),
    ['ETH', 'GROK'],
  )
})

// --- INJECTION-SAFETY GUARDS (must stay green: the real defenses) ---

test('safety: a fabricated value anchored to an unrelated raw is rejected', () => {
  const text = 'swap eth for grok'
  // Injected: value USDC but raw is the grammar word "for", not the symbol.
  assert.equal(intent.isValidEntity(ent('buyToken', 'USDC', 'for', text), text), false)
})

test('safety: a value whose raw is not present in the text is rejected', () => {
  const text = 'swap eth for grok'
  const e = { type: 'buyToken' as const, value: 'USDC', raw: 'usdc', start: 0, end: 4 }
  assert.equal(intent.isValidEntity(e, text), false)
})

test('safety: swap-grammar stop words are not admitted as tokens', () => {
  const text = 'swap eth for usdc and dai'
  for (const w of ['swap', 'for', 'and']) {
    assert.equal(intent.isValidEntity(ent('sellToken', w.toUpperCase(), w, text), text), false, `${w} must drop`)
  }
})

test('safety: documented alias still derives (ether -> ETH)', () => {
  const text = 'swap ether for usdc'
  assert.equal(intent.isValidEntity(ent('sellToken', 'ETH', 'ether', text), text), true)
})

test('alias: full-name mentions derive to their ticker', () => {
  const cases: Array<[string, string, string]> = [
    ['maker', 'MKR', 'swap maker for usd coin'],
    ['usd coin', 'USDC', 'swap maker for usd coin'],
    ['dogecoin', 'DOGE', 'buy dogecoin with eth'],
    ['lido', 'LDO', 'get lido for eth'],
  ]
  for (const [raw, value, text] of cases) {
    assert.equal(intent.valueDerivesFromRaw('token', value, raw), true, `${raw} -> ${value}`)
    assert.equal(intent.isValidEntity(ent('buyToken', value, raw, text), text), true, `entity ${raw} -> ${value}`)
  }
})

// --- CHAINS stay strictly gated (broadening is token-only) ---

test('chains: a bare chain mention without on/via/using is still dropped', () => {
  const text = 'swap base for usdc'
  assert.equal(intent.isValidEntity(ent('chain', 'base', 'base', text), text), false)
})

test('chains: a chain in routing context (on base) is still accepted', () => {
  const text = 'swap usdc for eth on base'
  assert.equal(intent.isValidEntity(ent('chain', 'base', 'base', text), text), true)
})

test('amount: a numeric amount derived from raw is accepted, junk is not', () => {
  const text = 'swap 100 usdc for eth'
  assert.equal(intent.isValidEntity(ent('amount', '100', '100', text), text), true)
  assert.equal(intent.isValidEntity(ent('amount', '999', '100', text), text), false)
})

// --- isPlausibleTokenSymbol: shape + stop-word predicate ---

test('isPlausibleTokenSymbol accepts real ticker shapes', () => {
  for (const s of ['USDC', 'WETH', 'PEPE', '1INCH', 'MOONPIG', 'GROK', 'AI16Z', 'BABYDOGE']) {
    assert.equal(intent.isPlausibleTokenSymbol(s), true, `${s} should be plausible`)
  }
})

test('isPlausibleTokenSymbol rejects stop words and bad shapes', () => {
  for (const s of ['SWAP', 'FOR', 'AND', 'THE', 'ON', 'TO', 'WITH', 'INTO', 'BUY', 'SELL', 'SOME', 'MY']) {
    assert.equal(intent.isPlausibleTokenSymbol(s), false, `stop word ${s} should drop`)
  }
  for (const s of ['', 'A', '123', '4', 'ABCDEFGHIJKLM', 'lower', 'A B', 'US-DC']) {
    assert.equal(intent.isPlausibleTokenSymbol(s), false, `bad shape ${JSON.stringify(s)} should drop`)
  }
})
