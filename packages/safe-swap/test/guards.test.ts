import { describe, it, expect } from 'vitest';
import {
  applySlippage,
  assertBuyFloor,
  assertErc20,
  assertRequestBound,
  assertSignedFeeZero,
  assertSlippageBps,
  assertTtlSeconds,
  MAX_SLIPPAGE_BPS,
  MAX_TTL_SECONDS,
} from '../src/guards.js';

const SELL = '0x1111111111111111111111111111111111111111';
const BUY = '0x2222222222222222222222222222222222222222';

describe('assertErc20', () => {
  it('accepts a valid ERC-20 address', () => {
    expect(() => assertErc20(SELL, 'Sell token')).not.toThrow();
  });
  it('rejects the native-ETH sentinel', () => {
    expect(() => assertErc20('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'Sell token')).toThrow(/native/i);
  });
  it('rejects the zero address', () => {
    expect(() => assertErc20('0x0000000000000000000000000000000000000000', 'Sell token')).toThrow(/native|zero/i);
  });
  it('rejects a malformed address', () => {
    expect(() => assertErc20('0xnothex', 'Sell token')).toThrow(/valid ERC-20/i);
  });
});

describe('assertSlippageBps / applySlippage', () => {
  it('accepts the full [0, MAX] range', () => {
    expect(() => assertSlippageBps(0)).not.toThrow();
    expect(() => assertSlippageBps(MAX_SLIPPAGE_BPS)).not.toThrow();
  });
  it('rejects above the cap', () => {
    expect(() => assertSlippageBps(MAX_SLIPPAGE_BPS + 1)).toThrow(/out of range/i);
  });
  it('rejects negative and non-integer', () => {
    expect(() => assertSlippageBps(-1)).toThrow();
    expect(() => assertSlippageBps(1.5)).toThrow();
  });
  it('lowers the amount by the bps', () => {
    expect(applySlippage(10_000n, 50)).toBe(9_950n);
    expect(applySlippage(10_000n, 0)).toBe(10_000n);
  });
});

describe('assertTtlSeconds', () => {
  it('accepts the [1, MAX] range', () => {
    expect(() => assertTtlSeconds(1)).not.toThrow();
    expect(() => assertTtlSeconds(1500)).not.toThrow();
    expect(() => assertTtlSeconds(MAX_TTL_SECONDS)).not.toThrow();
  });
  it('rejects zero, negative, and above the cap', () => {
    expect(() => assertTtlSeconds(0)).toThrow(/out of range/i);
    expect(() => assertTtlSeconds(-1)).toThrow(/out of range/i);
    expect(() => assertTtlSeconds(MAX_TTL_SECONDS + 1)).toThrow(/out of range/i);
  });
  it('rejects a non-integer', () => {
    expect(() => assertTtlSeconds(1500.5)).toThrow(/out of range/i);
  });
});

describe('assertSignedFeeZero', () => {
  it('accepts exactly "0"', () => {
    expect(() => assertSignedFeeZero('0')).not.toThrow();
  });
  it('rejects any non-zero signed feeAmount (fee must ride in appData)', () => {
    expect(() => assertSignedFeeZero('1')).toThrow(/feeAmount must be/i);
    expect(() => assertSignedFeeZero('1000000')).toThrow(/feeAmount must be/i);
  });
});

describe('assertRequestBound', () => {
  const ok = {
    requestedSellToken: SELL,
    requestedBuyToken: BUY,
    requestedGross: 1_000_000n,
    quoteSellToken: SELL,
    quoteBuyToken: BUY,
    quoteGross: 1_000_000n,
  };
  it('passes when tokens + gross match', () => {
    expect(() => assertRequestBound(ok)).not.toThrow();
  });
  it('is checksum-insensitive on tokens', () => {
    expect(() => assertRequestBound({ ...ok, quoteSellToken: SELL.toUpperCase().replace('0X', '0x') })).not.toThrow();
  });
  it('rejects a substituted sell token', () => {
    expect(() => assertRequestBound({ ...ok, quoteSellToken: BUY })).toThrow(/sellToken.*refusing to sign/i);
  });
  it('rejects a substituted buy token', () => {
    expect(() => assertRequestBound({ ...ok, quoteBuyToken: SELL })).toThrow(/buyToken.*refusing to sign/i);
  });
  it('rejects an over-pull (gross drift up)', () => {
    expect(() => assertRequestBound({ ...ok, quoteGross: 1_000_001n })).toThrow(/gross.*refusing to sign/i);
  });
  it('rejects an under-sell (gross drift down)', () => {
    expect(() => assertRequestBound({ ...ok, quoteGross: 999_999n })).toThrow(/gross.*refusing to sign/i);
  });
});

describe('assertBuyFloor', () => {
  it('accepts a positive floor', () => {
    expect(() => assertBuyFloor(1n)).not.toThrow();
  });
  it('rejects a zero-proceeds order', () => {
    expect(() => assertBuyFloor(0n)).toThrow(/zero-proceeds/i);
  });
  it('rejects a negative floor', () => {
    expect(() => assertBuyFloor(-1n)).toThrow(/zero-proceeds/i);
  });
  it('accepts when the floor meets the caller minBuyAmount', () => {
    expect(() => assertBuyFloor(1000n, 1000n)).not.toThrow();
  });
  it('rejects when the floor is below the caller minBuyAmount', () => {
    expect(() => assertBuyFloor(999n, 1000n)).toThrow(/below the caller|minimum out/i);
  });
});
