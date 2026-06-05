import { describe, it, expect, vi, beforeEach } from 'vitest';

// priceTrade prices non-reference tokens via CoW's native_price oracle; mock it so
// these stay pure unit tests (no network).
vi.mock('../src/cow/client.js', () => ({ nativePrice: vi.fn() }));

import { priceTrade } from '../src/pricer.js';
import { nativePrice } from '../src/cow/client.js';

const mockNativePrice = vi.mocked(nativePrice);
const UID = ('0x' + '0a'.repeat(56)) as `0x${string}`;
const WETH = '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1' as `0x${string}`;   // a non-reference token
const USDC_E = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83' as `0x${string}`;  // gnosis (100) USD reference, 6dp

beforeEach(() => mockNativePrice.mockReset());

describe('priceTrade — stablecoin self-pricing', () => {
  it('prices a USD-reference stablecoin sell at ITS decimals, not 18 (regression: was off by 1e12)', async () => {
    // Selling the chain's USD reference is already USD: 10,000 USDC.e @6dp -> $10,000.
    const usd = await priceTrade({ tradeUid: UID, chainId: 100, sellToken: USDC_E, sellAmount: 10_000_000_000n });
    expect(usd).toBeCloseTo(10_000, 2);
    expect(mockNativePrice).not.toHaveBeenCalled(); // short-circuit, no oracle/network
  });
});

describe('priceTrade — native_price oracle', () => {
  it('values a non-reference token by the native_price ratio (decimals cancel)', async () => {
    // priceTrade fetches the sellToken price first, then the USD-reference price:
    // np(sellToken)=2000 native-wei/atom, np(USDC.e ref)=1e12 native-wei/atom (~$1).
    mockNativePrice.mockResolvedValueOnce(2000).mockResolvedValueOnce(1_000_000_000_000);
    // 1 WETH (1e18 atoms): usd = 1e18 * 2000 / 1e12 / 10^6 = 2000.
    const usd = await priceTrade({ tradeUid: UID, chainId: 100, sellToken: WETH, sellAmount: 10n ** 18n });
    expect(usd).toBeCloseTo(2000, 4);
  });

  it('caches the per-chain USD-reference native_price across trades', async () => {
    mockNativePrice.mockResolvedValue(1_000_000_000_000);
    const cache = new Map<number, number>();
    const row = { tradeUid: UID, chainId: 100, sellToken: WETH, sellAmount: 10n ** 18n } as const;
    await priceTrade(row, cache);
    await priceTrade(row, cache);
    // 2 trades x (sellToken + ref) BUT the ref is cached after trade 1 -> 3 calls, not 4.
    expect(mockNativePrice).toHaveBeenCalledTimes(3);
  });

  it('throws (fail-safe: value_usd left NULL, retried) on a non-positive SELL price', async () => {
    // sell price 0 (couldn't price) with a VALID ref -> must NOT record $0 permanently.
    mockNativePrice.mockResolvedValueOnce(0).mockResolvedValueOnce(1_000_000_000_000);
    await expect(
      priceTrade({ tradeUid: UID, chainId: 100, sellToken: WETH, sellAmount: 1n }),
    ).rejects.toThrow(/native_price/);
  });

  it('throws (fail-safe: value_usd left NULL, retried) on a non-positive REF price', async () => {
    mockNativePrice.mockResolvedValueOnce(2000).mockResolvedValueOnce(0);
    await expect(
      priceTrade({ tradeUid: UID, chainId: 100, sellToken: WETH, sellAmount: 1n }),
    ).rejects.toThrow(/native_price/);
  });
});
