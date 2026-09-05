import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CowTrade } from '../src/cow/types.js';
import {
  listTrades,
  nativePrice,
  orderbookBase,
  SUPPORTED_CHAIN_IDS,
  OPTIMISM_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  UNICHAIN_CHAIN_ID,
} from '../src/cow/client.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('SUPPORTED_CHAIN_IDS / orderbookBase — sovereign + hosted routing', () => {
  it('includes every sovereign Ophis chain', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(OPTIMISM_CHAIN_ID);
    expect(SUPPORTED_CHAIN_IDS).toContain(UNICHAIN_CHAIN_ID); // else 130 trades never index
    expect(SUPPORTED_CHAIN_IDS).toContain(ROBINHOOD_CHAIN_ID);
  });

  it('routes each sovereign chain to its own self-hosted orderbook host root (NOT api.cow.fi)', () => {
    expect(orderbookBase(OPTIMISM_CHAIN_ID)).toBe('https://optimism-mainnet.ophis.fi');
    expect(orderbookBase(UNICHAIN_CHAIN_ID)).toBe('https://unichain-mainnet.ophis.fi');
    expect(orderbookBase(ROBINHOOD_CHAIN_ID)).toBe('https://robinhood-mainnet.ophis.fi');
  });

  it('routes hosted chains to api.cow.fi/{network} and throws on an unsupported chain', () => {
    expect(orderbookBase(100)).toBe('https://api.cow.fi/xdai');
    expect(() => orderbookBase(424_242)).toThrow(/unsupported chain/);
  });
});

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

describe('listTrades', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the API orderUid spelling for an exact settlement lookup', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const orderUid = `0x${'ab'.repeat(56)}` as `0x${string}`;
    await listTrades({ chainId: 1, orderUid });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(`orderUid=${orderUid}`);
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('order_uid=');
  });

  it('fails locally unless exactly one supported filter is provided', async () => {
    const owner = `0x${'12'.repeat(20)}` as `0x${string}`;
    const orderUid = `0x${'34'.repeat(56)}` as `0x${string}`;
    await expect(listTrades({ chainId: 1 })).rejects.toThrow(/exactly one/);
    await expect(listTrades({ chainId: 1, owner, orderUid })).rejects.toThrow(/exactly one/);
  });
});
