import { describe, it, expect } from 'vitest'
import { keccak256, toBytes } from 'viem'

import {
  deterministicStringify,
  buildOphisAppData,
  buildOrder,
  submitOrder,
  listChains,
  APP_DATA_VERSION,
  ORDER_TYPED_DATA_TYPES,
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
    expect(ad.partnerFee).toEqual({ priceImprovementBps: 2500, maxVolumeBps: 50, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' })
    expect(ad.doc.version).toBe(APP_DATA_VERSION)
    expect(ad.fullAppData).toContain('partnerFee')
    expect(ad.fullAppData).toContain('Ophis')
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
    expect(op?.partnerFee?.priceImprovementBps).toBe(2500)
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
