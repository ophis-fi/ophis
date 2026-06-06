import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CowTrade } from '../src/cow/types.js';
import { nativePrice } from '../src/cow/client.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('CowTrade schema', () => {
  it('parses every entry in tests/fixtures/cow-trades.json', () => {
    const data: unknown[] = JSON.parse(readFileSync(join(fixturesDir, 'cow-trades.json'), 'utf8'));
    expect(Array.isArray(data)).toBe(true);
    for (const entry of data) {
      expect(() => CowTrade.parse(entry)).not.toThrow();
    }
  });
});

describe('nativePrice', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs /token/{addr}/native_price with NO from/receiver/body (regression vs the zero-address /quote deny-list)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ price: 1672.69 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const price = await nativePrice(100, '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1');
    expect(price).toBe(1672.69);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/xdai\/api\/v1\/token\/0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1\/native_price$/);
    // A bodyless GET cannot carry from/receiver -> structurally immune to the deny-list.
    // (A timeout `signal` is added to all calls (#474) and is NOT a request payload.)
    const ri = init as RequestInit | undefined;
    expect(ri?.body).toBeUndefined();
    expect(ri?.method ?? 'GET').toBe('GET');
  });
});
