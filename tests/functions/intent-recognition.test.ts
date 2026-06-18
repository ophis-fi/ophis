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

// --- WORD BOUNDARY: a token raw must be a whole token, not a substring of a word ---

test('boundary: a symbol that is only a substring of a larger word is rejected', () => {
  // "base" inside "database", "ar" inside "car", "op" inside "shop" - the user
  // never typed these tokens; the substring includes() check alone would admit them.
  assert.equal(intent.isValidEntity(ent('buyToken', 'BASE', 'base', 'I keep my funds in a database'), 'I keep my funds in a database'), false)
  assert.equal(intent.isValidEntity(ent('sellToken', 'AR', 'ar', 'I bought a car today'), 'I bought a car today'), false)
  assert.equal(intent.isValidEntity(ent('buyToken', 'OP', 'op', 'I went to the shop'), 'I went to the shop'), false)
})

test('boundary: a standalone token is still accepted, and not blocked by another word containing it', () => {
  assert.equal(intent.isValidEntity(ent('sellToken', 'OP', 'op', 'swap op for usdc'), 'swap op for usdc'), true)
  // "eth" appears standalone AND inside "ethereum"; the standalone occurrence admits it.
  assert.equal(intent.isValidEntity(ent('sellToken', 'ETH', 'eth', 'send eth not on ethereum prose'), 'send eth not on ethereum prose'), true)
  // multi-word alias raw stays valid
  assert.equal(intent.isValidEntity(ent('buyToken', 'USDC', 'usd coin', 'swap eth for usd coin'), 'swap eth for usd coin'), true)
})

test('boundary: an ASCII symbol embedded in a non-ASCII word is rejected', () => {
  // "op" buried inside a Unicode-letter word must not count as the OP token.
  const text = 'gm αopβ frens'
  assert.equal(intent.isValidEntity(ent('buyToken', 'OP', 'op', text), text), false)
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

// --- DETERMINISTIC CHAIN FALLBACK (2026-06-17) ---
// The model (qwen3.6-27b) sometimes omits a chain the user named in routing
// context — notably "Optimism" (chain-vs-token ambiguity with the OP token, and
// the input placeholder). injectMissingChain recovers it from the user text without
// overriding a chain the model did emit. Recovery is ANCHORED to the swap operands:
// the chain must be the on/via/using directive immediately after the last token, so
// incidental "on <chain>" prose is NOT recovered (correctness audit 2026-06-17).

// Drive the REAL path: build a swap intent with the given token/amount operands (so
// the post-operand anchor is exercised), inject, and return the recovered chain.
function recover(text: string, tokens: ReadonlyArray<[EntityType, string, string]>): string | null {
  const entities = tokens.map(([t, v, r]) => ent(t, v, r, text))
  const out = intent.injectMissingChain({ intent: 'swap' as const, entities }, text)
  return out.entities.find((e) => e.type === 'chain')?.value ?? null
}
// "...usdc for eth ..." — eth (buy) is the operand the chain follows.
const UE: ReadonlyArray<[EntityType, string, string]> = [
  ['sellToken', 'USDC', 'usdc'],
  ['buyToken', 'ETH', 'eth'],
]

test('chain-fallback: recovers "on Optimism" the model dropped', () => {
  assert.equal(recover('trade 100 USDC for ETH on Optimism', UE), 'optimism')
  assert.equal(recover('swap 100 usdc for eth on optimism', UE), 'optimism') // the input placeholder
})

test('chain-fallback: recovers the "op" alias in routing context', () => {
  assert.equal(recover('swap usdc for eth on op', UE), 'optimism')
})

test('chain-fallback: recovers other routable chains + aliases', () => {
  assert.equal(recover('swap 100 usdc for eth on base', UE), 'base')
  assert.equal(
    recover('buy 1 eth with usdc on arbitrum', [
      ['buyToken', 'ETH', 'eth'],
      ['sellToken', 'USDC', 'usdc'],
    ]),
    'arbitrum',
  )
  assert.equal(
    recover('trade dai for usdt on bsc', [
      ['sellToken', 'DAI', 'dai'],
      ['buyToken', 'USDT', 'usdt'],
    ]),
    'bnb',
  )
  assert.equal(recover('swap usdc for eth using an l1', UE), 'ethereum')
})

test('chain-fallback: tolerates trailing network/chain word, punctuation, and filler', () => {
  assert.equal(recover('swap usdc for eth on the base network', UE), 'base')
  assert.equal(recover('trade 100 usdc for eth on optimism.', UE), 'optimism')
  assert.equal(recover('swap usdc for eth on op mainnet', UE), 'optimism')
  assert.equal(recover('swap usdc for eth on optimism right now', UE), 'optimism') // filler AFTER chain ok
})

test('chain-fallback: a thousands-separator comma in the amount is irrelevant', () => {
  assert.equal(
    recover('swap 1,000 usdc for eth on optimism', [
      ['amount', '1000', '1,000'],
      ['sellToken', 'USDC', 'usdc'],
      ['buyToken', 'ETH', 'eth'],
    ]),
    'optimism',
  )
})

// ANCHORED GATE (audit 2026-06-17): recovery fires only when the LLM declined a
// chain, which is also when the model correctly drops incidental "on <chain>" PROSE.
// Anchoring to the operand means prose with words between the token and the chain
// (with OR without a comma) is rejected. These pin that surface.

test('chain-fallback: does NOT recover incidental prose with a comma clause', () => {
  assert.equal(recover('swap 100 usdc for eth, gas paid on op', UE), null)
  assert.equal(recover('swap usdc for eth, cheapest fees on base right now', UE), null)
  assert.equal(recover('bridge then swap usdc for eth, listed on binance first', UE), null)
  assert.equal(recover('i want to swap usdc for eth, i saw it trending on polygon', UE), null)
})

test('chain-fallback: does NOT recover incidental COMMA-FREE prose (operand anchor)', () => {
  assert.equal(recover('swap 100 usdc for eth gas paid on op', UE), null)
  assert.equal(
    recover('buy eth with usdc cheapest gas is on base', [
      ['buyToken', 'ETH', 'eth'],
      ['sellToken', 'USDC', 'usdc'],
    ]),
    null,
  )
  assert.equal(recover('swap usdc for eth like everyone does on base', UE), null)
})

test('chain-fallback: does NOT recover a non-adjacent chain (deferred to the model/default)', () => {
  assert.equal(
    recover('buy 1 eth on arbitrum with usdc', [
      ['buyToken', 'ETH', 'eth'],
      ['sellToken', 'USDC', 'usdc'],
    ]),
    null,
  )
})

test('chain-fallback: multiple chains resolve to the one bound to the operands (first)', () => {
  assert.equal(recover('swap usdc for eth on base or on optimism', UE), 'base')
  assert.equal(recover('swap usdc for eth on optimism or on base', UE), 'optimism')
})

test('chain-fallback: a bare chain mention (no on/via/using) recovers nothing', () => {
  assert.equal(recover('swap optimism for usdc', [['buyToken', 'USDC', 'usdc']]), null)
  assert.equal(recover('100 base for usdc', [['buyToken', 'USDC', 'usdc']]), null)
})

test('chain-fallback: unsupported/unknown chains recover nothing', () => {
  assert.equal(recover('swap usdc for eth on solana', UE), null)
  assert.equal(recover('swap usdc for eth on megaeth', UE), null)
})

test('chain-fallback: a hyphenated suffix does not mis-match the chain (on base-fee)', () => {
  assert.equal(recover('swap usdc for eth on base-fee', UE), null)
})

test('injectMissingChain: ignores a manipulated model offset (anchors from the text, not entity.end)', () => {
  // Codex 2026-06-18: isValidEntity does not exact-validate offsets, so a malicious or
  // incorrect model `end` must NOT be able to move the operand anchor past incidental
  // "on <chain>" prose and inject a chain from it.
  const text = 'swap usdc for eth gas paid on op'
  const parsed = {
    intent: 'swap' as const,
    entities: [
      { type: 'sellToken' as const, value: 'USDC', raw: 'usdc', start: 5, end: 9 },
      // buyToken "eth" with a LIED end (real "eth" is at 14..17); end:26 points just before
      // " on op", which the OLD entity.end anchor would have used to inject `optimism`.
      { type: 'buyToken' as const, value: 'ETH', raw: 'eth', start: 14, end: 26 },
    ],
  }
  const out = intent.injectMissingChain(parsed, text)
  assert.equal(
    out.entities.some((e) => e.type === 'chain'),
    false,
  )
})

test('injectMissingChain: never overrides a chain the model already emitted', () => {
  const text = 'swap usdc for eth on base'
  const parsed = {
    intent: 'swap' as const,
    entities: [ent('buyToken', 'ETH', 'eth', text), ent('chain', 'base', 'base', text)],
  }
  const out = intent.injectMissingChain(parsed, text)
  const chains = out.entities.filter((e) => e.type === 'chain')
  assert.equal(chains.length, 1)
  assert.equal(chains[0].value, 'base')
})

test('injectMissingChain: leaves a chainless intent unchanged when no chain is named', () => {
  assert.equal(recover('swap 100 usdc for eth', UE), null)
})

test('injectMissingChain: is a strict no-op for a non-swap intent, even with a chain in text', () => {
  const text = 'what is the gas on optimism'
  const parsed = { intent: 'unknown' as const, entities: [] }
  const out = intent.injectMissingChain(parsed, text)
  assert.equal(out, parsed) // same reference, untouched
})

test('injectMissingChain: does not mutate its input', () => {
  const text = 'trade 100 usdc for eth on optimism'
  const entities = [ent('sellToken', 'USDC', 'usdc', text), ent('buyToken', 'ETH', 'eth', text)]
  const parsed = { intent: 'swap' as const, entities }
  const out = intent.injectMissingChain(parsed, text)
  assert.equal(entities.length, 2) // original array untouched
  assert.notEqual(out.entities, entities) // returns a new array
  assert.equal(out.entities.find((e) => e.type === 'chain')?.value, 'optimism')
})
