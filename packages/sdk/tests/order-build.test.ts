import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  deterministicStringify,
  buildOphisFullAppData,
  buildOrder,
  extractQuoteAmounts,
  assertLimitWithinSlippage,
  APP_DATA_VERSION,
  ORDER_TYPED_DATA_TYPES,
  MAX_SLIPPAGE_BIPS,
} from '@ophis/sdk';

// Mirrors the order-build coverage in apps/mcp-server/tests/ophis.test.ts, which
// stays in place as the WP0 regression harness (it consumes these same functions
// through the MCP re-export under their original names).

const OWNER = '0x931e9f531cdd4835Def0dEDE1452BA8aFbe5ff9b' as const;
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as const;
const WETH_OP = '0x4200000000000000000000000000000000000006' as const;
const ATTACKER = '0x000000000000000000000000000000000000dEaD' as const;
const OPHIS_OP_SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859';
const NOW = 1_900_000_000;

describe('deterministicStringify', () => {
  it('sorts object keys recursively and drops undefined', () => {
    expect(deterministicStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(deterministicStringify({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('buildOphisFullAppData', () => {
  it('embeds the CIP-75 partner fee on an Ophis fee chain (Optimism)', () => {
    const ad = buildOphisFullAppData(10);
    expect(ad.partnerFee).toEqual({ volumeBps: 5, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' });
    expect(ad.doc.version).toBe(APP_DATA_VERSION);
    expect(ad.fullAppData).toContain('partnerFee');
    expect(ad.fullAppData).toContain('"appCode":"ophis"');
  });

  it('hash is keccak256 of the exact submitted string, and is deterministic', () => {
    const a = buildOphisFullAppData(10);
    const b = buildOphisFullAppData(10);
    expect(a.appDataHash).toBe(b.appDataHash);
    expect(a.fullAppData).toBe(b.fullAppData);
    expect(a.appDataHash).toBe(keccak256(toBytes(a.fullAppData)));
    expect(a.appDataHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('omits partnerFee on a chain Ophis does not charge a fee on', () => {
    // 5 (Goerli) is not in OPHIS_FEE_CHAIN_IDS.
    const ad = buildOphisFullAppData(5);
    expect(ad.partnerFee).toBeUndefined();
    expect(ad.fullAppData).not.toContain('partnerFee');
  });

  it('embeds metadata.ophisSource.app only when a source is given, and it changes the hash', () => {
    const without = buildOphisFullAppData(10);
    const withSrc = buildOphisFullAppData(10, undefined, undefined, 'mcp');
    expect(without.fullAppData).not.toContain('ophisSource');
    expect(withSrc.fullAppData).toContain('"ophisSource":{"app":"mcp"}');
    expect((withSrc.doc.metadata as Record<string, unknown>).ophisSource).toEqual({ app: 'mcp' });
    // Distinct appData string => distinct signed hash.
    expect(withSrc.appDataHash).not.toBe(without.appDataHash);
    expect(withSrc.appDataHash).toBe(keccak256(toBytes(withSrc.fullAppData)));
  });
});

describe('buildOrder', () => {
  const base = {
    chainId: 10,
    owner: OWNER,
    sellToken: USDC_OP,
    buyToken: WETH_OP,
    sellAmount: '1000000',
    buyAmount: '250000000000000',
    kind: 'sell' as const,
  };

  it('pins the receiver to the owner by default', () => {
    const o = buildOrder(base, NOW);
    expect(o.order.receiver.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it('uses the NON-canonical Ophis settlement contract on Optimism', () => {
    const o = buildOrder(base, NOW);
    expect(o.signing.domain.verifyingContract).toBe(OPHIS_OP_SETTLEMENT);
    expect(o.signing.domain.name).toBe('Gnosis Protocol');
    expect(o.signing.domain.chainId).toBe(10);
    expect(o.signing.primaryType).toBe('Order');
    expect(ORDER_TYPED_DATA_TYPES.Order).toHaveLength(12);
  });

  it('order.appData equals the returned appDataHash (the signed bytes32)', () => {
    const o = buildOrder(base, NOW);
    expect(o.order.appData).toBe(o.appDataHash);
    expect(o.order.appData).toBe(keccak256(toBytes(o.fullAppData)));
  });

  it('computes validTo from nowSeconds + validForSeconds (default 1200)', () => {
    expect(buildOrder(base, NOW).order.validTo).toBe(NOW + 1200);
    expect(buildOrder({ ...base, validForSeconds: 60 }, NOW).order.validTo).toBe(NOW + 60);
  });

  it('allows an explicit unsafeCustomReceiver but keeps it deliberate', () => {
    const o = buildOrder({ ...base, unsafeCustomReceiver: ATTACKER }, NOW);
    expect(o.order.receiver.toLowerCase()).toBe(ATTACKER.toLowerCase());
  });

  it('rejects malformed addresses and non-atom amounts', () => {
    expect(() => buildOrder({ ...base, sellToken: 'not-an-address' as never }, NOW)).toThrow();
    expect(() => buildOrder({ ...base, sellAmount: '0' }, NOW)).toThrow();
    expect(() => buildOrder({ ...base, sellAmount: '1.5' }, NOW)).toThrow();
  });

  it('rejects amounts above uint256 max, accepts exactly max', () => {
    const over = (2n ** 256n).toString();
    const max = (2n ** 256n - 1n).toString();
    expect(() => buildOrder({ ...base, sellAmount: over }, NOW)).toThrow();
    expect(() => buildOrder({ ...base, buyAmount: over }, NOW)).toThrow();
    expect(() => buildOrder({ ...base, feeAmount: over }, NOW)).toThrow();
    expect(() => buildOrder({ ...base, sellAmount: max, buyAmount: max }, NOW)).not.toThrow();
  });

  it('caps slippageBips at MAX_SLIPPAGE_BIPS (50%); the PURE lib does not itself price-check', () => {
    expect(MAX_SLIPPAGE_BIPS).toBe(5000);
    expect(() => buildOrder({ ...base, slippageBips: 5001 }, NOW)).toThrow();
    expect(() => buildOrder({ ...base, slippageBips: 5000 }, NOW)).not.toThrow();
    // buildOrder stays PURE (no network/quote): a "min out = 1" limit passes the lib.
    // Slippage is ENFORCED against a server-fetched quote in the MCP build_order
    // handler (getQuote + assertLimitWithinSlippage), which is tested via those units.
    expect(() => buildOrder({ ...base, buyAmount: '1', slippageBips: 100 }, NOW)).not.toThrow();
  });
});

describe('extractQuoteAmounts', () => {
  it('extracts sell/buy atoms from a CoW quote response', () => {
    expect(extractQuoteAmounts({ quote: { sellAmount: '1000000', buyAmount: '250000000000000' } })).toEqual({
      sellAmount: '1000000',
      buyAmount: '250000000000000',
    });
  });

  it('returns null for missing or malformed amounts', () => {
    expect(extractQuoteAmounts(null)).toBeNull();
    expect(extractQuoteAmounts({})).toBeNull();
    expect(extractQuoteAmounts({ quote: {} })).toBeNull();
    expect(extractQuoteAmounts({ quote: { sellAmount: '1.5', buyAmount: '1' } })).toBeNull();
    expect(extractQuoteAmounts({ quote: { sellAmount: 1000000, buyAmount: '1' } })).toBeNull();
  });
});

describe('assertLimitWithinSlippage (trusted-quote enforcement)', () => {
  const fair = { sellAmount: '1000000', buyAmount: '250000000000000' };

  it('accepts a sell min-out within slippage of the quote', () => {
    expect(() => assertLimitWithinSlippage('sell', '1000000', fair.buyAmount, fair, 100)).not.toThrow();
    const floor = ((250000000000000n * 9900n) / 10000n).toString(); // exactly 1% below
    expect(() => assertLimitWithinSlippage('sell', '1000000', floor, fair, 100)).not.toThrow();
  });

  it('rejects a sell min-out below the slippage floor (the "min out = 1" attack)', () => {
    expect(() => assertLimitWithinSlippage('sell', '1000000', '1', fair, 100)).toThrow();
  });

  it('accepts a buy max-in within slippage and rejects one above', () => {
    expect(() => assertLimitWithinSlippage('buy', fair.sellAmount, '250000000000000', fair, 100)).not.toThrow();
    expect(() => assertLimitWithinSlippage('buy', '100000000000', '250000000000000', fair, 100)).toThrow();
  });

  it('defaults to a 100-bps (1%) backstop when slippageBips is omitted', () => {
    expect(() => assertLimitWithinSlippage('sell', '1000000', '1', fair)).toThrow(); // far below the 1% floor
    const floor = ((250000000000000n * 9900n) / 10000n).toString(); // exactly 1% below, within the default
    expect(() => assertLimitWithinSlippage('sell', '1000000', floor, fair)).not.toThrow();
    const below = ((250000000000000n * 9800n) / 10000n).toString(); // 2% below, past the 1% default
    expect(() => assertLimitWithinSlippage('sell', '1000000', below, fair)).toThrow();
  });

  it('widens the bound by the CIP-75 partner fee so legit fee-chain orders are not false-rejected', () => {
    // A signed order on a fee chain is net of the partner fee: with 50 bips slippage
    // and a 10 bips partner fee, the legit min-out sits ~60 bips below the raw quote.
    const out60 = ((250000000000000n * (10000n - 60n)) / 10000n).toString();
    // Without the partner fee (bound = 50 bips) the 60-bips-below limit is rejected...
    expect(() => assertLimitWithinSlippage('sell', '1000000', out60, fair, 50)).toThrow();
    // ...but passing partnerFeeBps = 10 widens the bound to 60 bips and it passes.
    expect(() => assertLimitWithinSlippage('sell', '1000000', out60, fair, 50, 10)).not.toThrow();
    // Symmetric on the buy side: a max-in 60 bips above the quote needs the fee allowance.
    const in60 = ((1000000n * (10000n + 60n)) / 10000n).toString();
    expect(() => assertLimitWithinSlippage('buy', in60, '250000000000000', fair, 50)).toThrow();
    expect(() => assertLimitWithinSlippage('buy', in60, '250000000000000', fair, 50, 10)).not.toThrow();
    // The fee allowance does NOT rescue the "min out = 1" attack (still way past the band).
    expect(() => assertLimitWithinSlippage('sell', '1000000', '1', fair, 50, 10)).toThrow();
  });
});
