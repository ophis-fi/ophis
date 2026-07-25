import { describe, expect, it } from 'vitest';
import {
  OPHIS_BASKET_ID_RE,
  MAX_BASKET_LEGS,
  MAX_BASKET_SELL_TOKENS,
  MAX_BASKET_BUY_TOKENS,
  assertOphisBasketId,
  newOphisBasketId,
  assertOphisBasketLegs,
  buildOphisBasketMetadata,
} from '../src/basket-metadata.js';

describe('basket caps (owner decision 39: 6x6 product cap, up to 6 legs)', () => {
  it('pins the 6x6 product cap and the 6-leg cap', () => {
    expect(MAX_BASKET_SELL_TOKENS).toBe(6);
    expect(MAX_BASKET_BUY_TOKENS).toBe(6);
    expect(MAX_BASKET_LEGS).toBe(6);
  });
});

describe('assertOphisBasketId / OPHIS_BASKET_ID_RE', () => {
  it('accepts a 32-lowercase-hex id', () => {
    const id = 'a'.repeat(32);
    expect(assertOphisBasketId(id)).toBe(id);
    expect(assertOphisBasketId('0123456789abcdef0123456789abcdef')).toBe(
      '0123456789abcdef0123456789abcdef',
    );
  });

  it('rejects ids that cannot round-trip through the indexer basket_id column', () => {
    expect(() => assertOphisBasketId('')).toThrow();
    expect(() => assertOphisBasketId('a'.repeat(31))).toThrow(); // too short
    expect(() => assertOphisBasketId('a'.repeat(33))).toThrow(); // too long
    expect(() => assertOphisBasketId('A'.repeat(32))).toThrow(); // uppercase
    expect(() => assertOphisBasketId('g'.repeat(32))).toThrow(); // non-hex
    expect(() => assertOphisBasketId('0123456789abcdef0123456789abcde ')).toThrow(); // space
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertOphisBasketId(undefined as any)).toThrow();
  });

  it('exports a grammar the frontend mirror and invariant script must match', () => {
    // If this regex source diverges from the frontend basketMetadata.ts mirror,
    // a marker built here would not group the same rows the indexer / frontend
    // recognise. check-basket-metadata-invariant.sh pins them byte-identical.
    expect(OPHIS_BASKET_ID_RE.source).toBe('^[0-9a-f]{32}$');
  });
});

describe('newOphisBasketId', () => {
  it('mints a valid id from an injected deterministic RNG', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_v, i) => i); // 00,01,...,0f
    const id = newOphisBasketId(() => bytes);
    expect(id).toBe('000102030405060708090a0b0c0d0e0f');
    expect(OPHIS_BASKET_ID_RE.test(id)).toBe(true);
    expect(assertOphisBasketId(id)).toBe(id);
  });

  it('zero-pads each byte to two hex chars (full 32-char length)', () => {
    const id = newOphisBasketId(() => new Uint8Array(16)); // all zero
    expect(id).toBe('0'.repeat(32));
    expect(id).toHaveLength(32);
  });

  it('uses only the first 16 bytes when given more', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_v, i) => i);
    const id = newOphisBasketId(() => bytes);
    expect(id).toBe('000102030405060708090a0b0c0d0e0f');
  });

  it('throws when the RNG returns fewer than 16 bytes', () => {
    expect(() => newOphisBasketId(() => new Uint8Array(8))).toThrow();
  });
});

describe('assertOphisBasketLegs', () => {
  it('accepts every valid (leg, legs) pair up to the cap', () => {
    for (let legs = 1; legs <= MAX_BASKET_LEGS; legs++) {
      for (let leg = 1; leg <= legs; leg++) {
        expect(() => assertOphisBasketLegs(leg, legs)).not.toThrow();
      }
    }
  });

  it('rejects legs out of [1, MAX_BASKET_LEGS]', () => {
    expect(() => assertOphisBasketLegs(1, 0)).toThrow();
    expect(() => assertOphisBasketLegs(1, MAX_BASKET_LEGS + 1)).toThrow();
    expect(() => assertOphisBasketLegs(1, 2.5)).toThrow();
  });

  it('rejects leg out of [1, legs]', () => {
    expect(() => assertOphisBasketLegs(0, 3)).toThrow();
    expect(() => assertOphisBasketLegs(4, 3)).toThrow(); // leg > legs
    expect(() => assertOphisBasketLegs(2.5, 3)).toThrow();
  });
});

describe('buildOphisBasketMetadata', () => {
  it('produces the ophisBasket marker the indexer and frontend read', () => {
    const id = 'deadbeefdeadbeefdeadbeefdeadbeef';
    expect(buildOphisBasketMetadata({ id, leg: 2, legs: 3 })).toEqual({
      ophisBasket: { id, leg: 2, legs: 3 },
    });
  });

  it('merges cleanly into an existing metadata object (leg keeps siblings)', () => {
    const id = newOphisBasketId(() => Uint8Array.from({ length: 16 }, () => 0xab));
    const metadata = {
      orderClass: { orderClass: 'market' },
      ...buildOphisBasketMetadata({ id, leg: 1, legs: 6 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((metadata as any).ophisBasket).toEqual({ id, leg: 1, legs: 6 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((metadata as any).orderClass.orderClass).toBe('market');
  });

  it('throws (does not silently drop) on a bad id or leg pair', () => {
    expect(() => buildOphisBasketMetadata({ id: 'nope', leg: 1, legs: 1 })).toThrow();
    expect(() =>
      buildOphisBasketMetadata({ id: 'a'.repeat(32), leg: 7, legs: 6 }),
    ).toThrow();
  });

  it('is a mandatory marker: a single-leg basket still carries it', () => {
    const id = 'a'.repeat(32);
    expect(buildOphisBasketMetadata({ id, leg: 1, legs: 1 })).toEqual({
      ophisBasket: { id, leg: 1, legs: 1 },
    });
  });
});
