import { describe, it, expect, vi, beforeEach } from 'vitest';

// priceTrade prices non-reference tokens via CoW's native_price oracle; mock it so
// these stay pure unit tests (no network). isSelfHosted gates the 18-decimal
// native_price correction (self-hosted OP/HyperEVM only); the hosted-chain cases run
// on chain 100, so it returns false and no on-chain RPC is touched.
vi.mock('../src/cow/client.js', () => ({
  nativePrice: vi.fn(),
  OPTIMISM_CHAIN_ID: 10,
  HYPEREVM_CHAIN_ID: 999,
  isSelfHosted: (chainId: number) => chainId === 10 || chainId === 999,
}));

// On the self-hosted (OP/999) correction path priceTrade reads the sell token's
// on-chain decimals via viem. Mock viem so the ERC20 decimals() read returns a
// fixed value with no network — readContract is the only viem surface exercised.
const mockReadContract = vi.fn();
vi.mock('viem', () => ({
  createPublicClient: () => ({ readContract: mockReadContract }),
  http: () => ({}),
  getAddress: (a: string) => a,
  parseAbi: (a: unknown) => a,
}));

import { priceTrade, assertUsdReferenceSane, decimalsRpcFor } from '../src/pricer.js';
import { nativePrice } from '../src/cow/client.js';

const mockNativePrice = vi.mocked(nativePrice);
const UID = ('0x' + '0a'.repeat(56)) as `0x${string}`;
const WETH = '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1' as `0x${string}`;   // a non-reference token
const USDC_E = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83' as `0x${string}`;  // gnosis (100) USD reference, 6dp

beforeEach(() => {
  mockNativePrice.mockReset();
  mockReadContract.mockReset();
});

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

describe('assertUsdReferenceSane — shared-OFT exemption (HyperEVM 999 re-enable regression)', () => {
  it('does NOT throw with the USDT0 OFT shared across Plasma (9745) and HyperEVM (999)', () => {
    // 999 and 9745 both map to USDT0 0xb8ce…ebb (LayerZero OFT, same address by
    // design). Without the KNOWN_SHARED_OFTS allowlist this throws at boot. (BLOCKER)
    expect(() => assertUsdReferenceSane()).not.toThrow();
  });
});

describe('USD_REFERENCE[999] — HyperEVM USDT0', () => {
  const USDT0 = '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb' as `0x${string}`;
  it('prices the chain-999 USD reference (USDT0, 6dp) by self-pricing short-circuit, no oracle call', async () => {
    // Selling USDT0 on HyperEVM is already USD: 5,000 USDT0 @6dp -> $5,000. The
    // short-circuit uses USD_REFERENCE[999].token + .decimals (6), proving the entry.
    const usd = await priceTrade({ tradeUid: UID, chainId: 999, sellToken: USDT0, sellAmount: 5_000_000_000n });
    expect(usd).toBeCloseTo(5_000, 2);
    expect(mockNativePrice).not.toHaveBeenCalled();
  });
});

describe('decimalsRpcFor — per-chain self-hosted RPC routing', () => {
  // Env-overridable with hard defaults; resolve the expected URL the same way so the
  // test passes whether or not OPTIMISM_RPC_URL / HYPEREVM_RPC_URL are set in CI.
  const expectedOp = process.env.OPTIMISM_RPC_URL ?? 'https://mainnet.optimism.io';
  const expectedHl = process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm';

  it('routes HyperEVM (999) to the HyperEVM RPC and OP (10) to the OP RPC', () => {
    expect(decimalsRpcFor(999)).toBe(expectedHl);
    expect(decimalsRpcFor(10)).toBe(expectedOp);
    // The two self-hosted chains must NOT share an RPC (regression: 999 read OP decimals).
    expect(decimalsRpcFor(999)).not.toBe(decimalsRpcFor(10));
  });

  it('hard-throws for an unmapped self-hosted chain (no silent OP fallback)', () => {
    expect(() => decimalsRpcFor(12345)).toThrow(/no decimals RPC mapped/);
  });
});

describe('priceTrade — self-hosted 999 correctOpNativePrice (18-dec normalization)', () => {
  const WHYPE = '0x5555555555555555555555555555555555555555' as `0x${string}`; // non-reference 18dp token on 999
  it('applies the 18-dec correction to a non-reference 999 sell token (decimals read on-chain)', async () => {
    // Self-hosted backend returns 18-dec-normalized native_price for BOTH sides.
    // WHYPE is 18dp (correction factor 10^(18-18)=1, price unchanged); USDT0 ref is
    // 6dp (correction factor 10^(18-6)=1e12, so the 18-dec-inflated ref is divided back).
    // np(WHYPE)=2 native-wei/atom (corrected: 2), np(USDT0 ref)=1e12 (corrected: 1).
    mockNativePrice.mockResolvedValueOnce(2).mockResolvedValueOnce(1_000_000_000_000);
    mockReadContract.mockResolvedValueOnce(18); // WHYPE on-chain decimals over the 999 RPC
    // 1 WHYPE (1e18 atoms): usd = 1e18 * 2 / 1 / 10^6(ref decimals) = 2e12 ... but the
    // ref-price correction divides refPrice by 1e12 -> refPrice=1, so usd = 1e18*2/1/1e6.
    const usd = await priceTrade({ tradeUid: UID, chainId: 999, sellToken: WHYPE, sellAmount: 10n ** 18n });
    // sellPrice corrected: 2 / 10^(18-18) = 2; refPrice corrected: 1e12 / 10^(18-6) = 1.
    // usd = 1e18 * 2 / 1 / 10^6 = 2_000_000_000_000.
    expect(usd).toBeCloseTo(2_000_000_000_000, 0);
    expect(mockReadContract).toHaveBeenCalledTimes(1); // decimals read once for the sell token
  });
});
