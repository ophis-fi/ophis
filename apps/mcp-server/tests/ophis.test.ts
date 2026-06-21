import { describe, it, expect } from 'vitest'
import { keccak256, toBytes } from 'viem'

import {
  deterministicStringify,
  buildOphisAppData,
  buildOrder,
  getQuote,
  submitOrder,
  listChains,
  APP_DATA_VERSION,
  ORDER_TYPED_DATA_TYPES,
  extractQuoteAmounts,
  assertLimitWithinSlippage,
} from '../src/ophis.js'

const OWNER = '0x931e9f531cdd4835Def0dEDE1452BA8aFbe5ff9b' as const
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as const
const WETH_OP = '0x4200000000000000000000000000000000000006' as const
const ATTACKER = '0x000000000000000000000000000000000000dEaD' as const
const OPHIS_OP_SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859'
const NOW = 1_900_000_000

describe('deterministicStringify', () => {
  it('sorts object keys recursively and drops undefined', () => {
    expect(deterministicStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(deterministicStringify({ a: undefined, b: 2 })).toBe('{"b":2}')
  })
})

describe('buildOphisAppData', () => {
  it('embeds the CIP-75 partner fee on an Ophis fee chain (Optimism)', () => {
    const ad = buildOphisAppData(10)
    expect(ad.partnerFee).toEqual({ volumeBps: 5, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' })
    expect(ad.doc.version).toBe(APP_DATA_VERSION)
    expect(ad.fullAppData).toContain('partnerFee')
    expect(ad.fullAppData).toContain('"appCode":"ophis"')
  })

  it('hash is keccak256 of the exact submitted string, and is deterministic', () => {
    const a = buildOphisAppData(10)
    const b = buildOphisAppData(10)
    expect(a.appDataHash).toBe(b.appDataHash)
    expect(a.fullAppData).toBe(b.fullAppData)
    expect(a.appDataHash).toBe(keccak256(toBytes(a.fullAppData)))
    expect(a.appDataHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('omits partnerFee on a chain Ophis does not charge a fee on', () => {
    // 5 (Goerli) is not in OPHIS_FEE_CHAIN_IDS.
    const ad = buildOphisAppData(5)
    expect(ad.partnerFee).toBeUndefined()
    expect(ad.fullAppData).not.toContain('partnerFee')
  })
})

describe('buildOrder', () => {
  const base = {
    chainId: 10,
    owner: OWNER,
    sellToken: USDC_OP,
    buyToken: WETH_OP,
    sellAmount: '1000000',
    buyAmount: '250000000000000',
    kind: 'sell' as const,
  }

  it('pins the receiver to the owner by default', () => {
    const o = buildOrder(base, NOW)
    expect(o.order.receiver.toLowerCase()).toBe(OWNER.toLowerCase())
  })

  it('uses the NON-canonical Ophis settlement contract on Optimism', () => {
    const o = buildOrder(base, NOW)
    expect(o.signing.domain.verifyingContract).toBe(OPHIS_OP_SETTLEMENT)
    expect(o.signing.domain.name).toBe('Gnosis Protocol')
    expect(o.signing.domain.chainId).toBe(10)
    expect(o.signing.primaryType).toBe('Order')
    expect(ORDER_TYPED_DATA_TYPES.Order).toHaveLength(12)
  })

  it('order.appData equals the returned appDataHash (the signed bytes32)', () => {
    const o = buildOrder(base, NOW)
    expect(o.order.appData).toBe(o.appDataHash)
    expect(o.order.appData).toBe(keccak256(toBytes(o.fullAppData)))
  })

  it('computes validTo from nowSeconds + validForSeconds (default 1200)', () => {
    expect(buildOrder(base, NOW).order.validTo).toBe(NOW + 1200)
    expect(buildOrder({ ...base, validForSeconds: 60 }, NOW).order.validTo).toBe(NOW + 60)
  })

  it('allows an explicit unsafeCustomReceiver but keeps it deliberate', () => {
    const o = buildOrder({ ...base, unsafeCustomReceiver: ATTACKER }, NOW)
    expect(o.order.receiver.toLowerCase()).toBe(ATTACKER.toLowerCase())
  })

  it('rejects malformed addresses and non-atom amounts', () => {
    expect(() => buildOrder({ ...base, sellToken: 'not-an-address' as never }, NOW)).toThrow()
    expect(() => buildOrder({ ...base, sellAmount: '0' }, NOW)).toThrow()
    expect(() => buildOrder({ ...base, sellAmount: '1.5' }, NOW)).toThrow()
  })

  it('rejects amounts above uint256 max, accepts exactly max', () => {
    const over = (2n ** 256n).toString()
    const max = (2n ** 256n - 1n).toString()
    expect(() => buildOrder({ ...base, sellAmount: over }, NOW)).toThrow()
    expect(() => buildOrder({ ...base, buyAmount: over }, NOW)).toThrow()
    expect(() => buildOrder({ ...base, feeAmount: over }, NOW)).toThrow()
    expect(() => buildOrder({ ...base, sellAmount: max, buyAmount: max }, NOW)).not.toThrow()
  })

  it('caps slippageBips at 50%; the PURE lib does not itself price-check (the MCP handler does)', () => {
    expect(() => buildOrder({ ...base, slippageBips: 5001 }, NOW)).toThrow()
    expect(() => buildOrder({ ...base, slippageBips: 5000 }, NOW)).not.toThrow()
    // buildOrder stays PURE (no network/quote): a "min out = 1" limit passes the lib.
    // Slippage is ENFORCED against a server-fetched quote in the MCP build_order
    // handler (getQuote + assertLimitWithinSlippage), which is tested via those units.
    expect(() => buildOrder({ ...base, buyAmount: '1', slippageBips: 100 }, NOW)).not.toThrow()
  })
})

describe('getQuote (enforcement-quote lifetime)', () => {
  const base = {
    chainId: 10,
    sellToken: USDC_OP,
    buyToken: WETH_OP,
    kind: 'sell' as const,
    amount: '1000000',
    from: OWNER,
  }

  // Stub fetch that snapshots the request body so we can assert what lifetime
  // field the quote is requested for (validTo vs validFor) at the wire level.
  function captureFetch() {
    let captured: string | undefined
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = init.body as string
      return new Response(JSON.stringify({ quote: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, body: () => JSON.parse(captured ?? '{}') as Record<string, unknown> }
  }

  it('quotes for the EXACT absolute validTo when supplied; validForSeconds is ignored', async () => {
    // This is the order-lifetime alignment the build_order handler relies on: the
    // enforcement quote must describe the SAME order being signed, not a relative
    // window that re-anchors to the orderbook's later request-receive time.
    const cap = captureFetch()
    await getQuote({ ...base, validTo: NOW + 60, validForSeconds: 999 }, cap.fetchImpl)
    const body = cap.body()
    expect(body.validTo).toBe(NOW + 60)
    expect(body.validFor).toBeUndefined()
  })

  it('falls back to a relative validFor window when no validTo is given', async () => {
    const cap = captureFetch()
    await getQuote({ ...base, validForSeconds: 300 }, cap.fetchImpl)
    const body = cap.body()
    expect(body.validFor).toBe(300)
    expect(body.validTo).toBeUndefined()
  })

  it('defaults validFor to 1200 when neither validTo nor validForSeconds is set', async () => {
    const cap = captureFetch()
    await getQuote(base, cap.fetchImpl)
    const body = cap.body()
    expect(body.validFor).toBe(1200)
    expect(body.validTo).toBeUndefined()
  })
})

describe('submitOrder (relay guards — no network on the throw paths)', () => {
  const base = {
    chainId: 10,
    owner: OWNER,
    sellToken: USDC_OP,
    buyToken: WETH_OP,
    sellAmount: '1000000',
    buyAmount: '250000000000000',
    kind: 'sell' as const,
  }
  const SIG = '0x' + 'ab'.repeat(65)

  it('REFUSES to relay a non-owner receiver without allowCustomReceiver (drain guard)', async () => {
    const drain = buildOrder({ ...base, unsafeCustomReceiver: ATTACKER }, NOW)
    await expect(
      submitOrder({ chainId: 10, order: drain.order, signature: SIG, from: OWNER, fullAppData: drain.fullAppData }),
    ).rejects.toThrow(/receiver/i)
  })

  it('REFUSES fullAppData that does not hash to order.appData', async () => {
    const o = buildOrder(base, NOW)
    await expect(
      submitOrder({ chainId: 10, order: o.order, signature: SIG, from: OWNER, fullAppData: '{"tampered":true}' }),
    ).rejects.toThrow(/hash/i)
  })

  it('rejects a malformed signature before any network call', async () => {
    const o = buildOrder(base, NOW)
    await expect(
      submitOrder({ chainId: 10, order: o.order, signature: 'nope', from: OWNER, fullAppData: o.fullAppData }),
    ).rejects.toThrow(/signature/i)
  })

  it('relays when receiver is the owner and appData matches (stubbed fetch)', async () => {
    const o = buildOrder(base, NOW)
    const stub = (async () =>
      new Response(JSON.stringify('0xUID'), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const r = await submitOrder({ chainId: 10, order: o.order, signature: SIG, from: OWNER, fullAppData: o.fullAppData }, stub)
    expect(r).toBe('0xUID')
  })
})

describe('listChains', () => {
  it('puts Optimism in tradeable with the non-canonical settlement + live orderbook', () => {
    const op = listChains().tradeable.find((c) => c.chainId === 10)
    expect(op?.ophisOperated).toBe(true)
    expect(op?.settlement).toBe(OPHIS_OP_SETTLEMENT)
    expect(op?.orderbookUrl).toBe('https://optimism-mainnet.ophis.fi')
    expect(op?.partnerFee?.volumeBps).toBe(5)
  })

  it('puts Ethereum mainnet in tradeable with the canonical settlement', () => {
    const eth = listChains().tradeable.find((c) => c.chainId === 1)
    expect(eth?.ophisOperated).toBe(false)
    expect(eth?.settlement).toBe('0x9008D19f58AAbD9eD0D60971565AA8510560ab41')
  })

  it('puts orderbook-paused fee chains (MegaETH, HyperEVM) in paused, not tradeable', () => {
    const { tradeable, paused } = listChains()
    expect(paused.map((c) => c.chainId)).toEqual(expect.arrayContaining([4326, 999]))
    expect(tradeable.map((c) => c.chainId)).not.toContain(4326)
    expect(tradeable.map((c) => c.chainId)).not.toContain(999)
    // Every tradeable chain has a real orderbook URL (no dead-ends).
    expect(tradeable.every((c) => typeof c.orderbookUrl === 'string')).toBe(true)
  })
})

describe('extractQuoteAmounts', () => {
  it('extracts sell/buy atoms from a CoW quote response', () => {
    expect(extractQuoteAmounts({ quote: { sellAmount: '1000000', buyAmount: '250000000000000' } })).toEqual({
      sellAmount: '1000000',
      buyAmount: '250000000000000',
    })
  })

  it('returns null for missing or malformed amounts', () => {
    expect(extractQuoteAmounts(null)).toBeNull()
    expect(extractQuoteAmounts({})).toBeNull()
    expect(extractQuoteAmounts({ quote: {} })).toBeNull()
    expect(extractQuoteAmounts({ quote: { sellAmount: '1.5', buyAmount: '1' } })).toBeNull()
    expect(extractQuoteAmounts({ quote: { sellAmount: 1000000, buyAmount: '1' } })).toBeNull()
  })
})

describe('assertLimitWithinSlippage (trusted-quote enforcement)', () => {
  const fair = { sellAmount: '1000000', buyAmount: '250000000000000' }

  it('accepts a sell min-out within slippage of the quote', () => {
    expect(() => assertLimitWithinSlippage('sell', '1000000', fair.buyAmount, fair, 100)).not.toThrow()
    const floor = ((250000000000000n * 9900n) / 10000n).toString() // exactly 1% below
    expect(() => assertLimitWithinSlippage('sell', '1000000', floor, fair, 100)).not.toThrow()
  })

  it('rejects a sell min-out below the slippage floor (the "min out = 1" attack)', () => {
    expect(() => assertLimitWithinSlippage('sell', '1000000', '1', fair, 100)).toThrow()
  })

  it('accepts a buy max-in within slippage and rejects one above', () => {
    expect(() => assertLimitWithinSlippage('buy', fair.sellAmount, '250000000000000', fair, 100)).not.toThrow()
    expect(() => assertLimitWithinSlippage('buy', '100000000000', '250000000000000', fair, 100)).toThrow()
  })

  it('defaults to the 50% cap when slippageBips is omitted', () => {
    expect(() => assertLimitWithinSlippage('sell', '1000000', '1', fair)).toThrow() // >50% below
    const out40 = ((250000000000000n * 6000n) / 10000n).toString() // 40% below -> within 50% default
    expect(() => assertLimitWithinSlippage('sell', '1000000', out40, fair)).not.toThrow()
  })

  it('widens the bound by the CIP-75 partner fee so legit fee-chain orders are not false-rejected', () => {
    // A signed order on a fee chain is net of the partner fee: with 50 bips slippage
    // and a 10 bips partner fee, the legit min-out sits ~60 bips below the raw quote.
    const out60 = ((250000000000000n * (10000n - 60n)) / 10000n).toString()
    // Without the partner fee (bound = 50 bips) the 60-bips-below limit is rejected...
    expect(() => assertLimitWithinSlippage('sell', '1000000', out60, fair, 50)).toThrow()
    // ...but passing partnerFeeBps = 10 widens the bound to 60 bips and it passes.
    expect(() => assertLimitWithinSlippage('sell', '1000000', out60, fair, 50, 10)).not.toThrow()
    // Symmetric on the buy side: a max-in 60 bips above the quote needs the fee allowance.
    const in60 = ((1000000n * (10000n + 60n)) / 10000n).toString()
    expect(() => assertLimitWithinSlippage('buy', in60, '250000000000000', fair, 50)).toThrow()
    expect(() => assertLimitWithinSlippage('buy', in60, '250000000000000', fair, 50, 10)).not.toThrow()
    // The fee allowance does NOT rescue the "min out = 1" attack (still way past the band).
    expect(() => assertLimitWithinSlippage('sell', '1000000', '1', fair, 50, 10)).toThrow()
  })
})
