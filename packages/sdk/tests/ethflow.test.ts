import { describe, expect, it } from 'vitest';
import {
  OPHIS_ETHFLOW_ADDRESSES,
  isOphisEthFlowChain,
  getOphisEthFlowAddress,
  buildOphisEthFlowOrder,
  ethFlowOrderToTuple,
  ETHFLOW_CREATE_ORDER_ABI,
  type OphisEthFlowParams,
} from '../src/ethflow.js';

const OWNER = '0x6D46e28aB34622d9A39d0F306a37a8dC270951aF' as const;
const OTHER = '0x1111111111111111111111111111111111111111' as const;
const BUY_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const; // USDC
const APP_DATA_HASH = ('0x' + '11'.repeat(32)) as `0x${string}`;
const FULL_APP_DATA = '{"appCode":"ophis","metadata":{}}';
const ZERO = '0x0000000000000000000000000000000000000000' as const;

const OP_ETHFLOW = '0x764fE4aa1FF493cf39931c7923C8ff5837596504';
const HYPEREVM_ETHFLOW = '0xd031Ce1C577caD1530BD8283CaA6a6a106A5b61B';
const CANONICAL = '0xba3cb449bd2b4adddbc894d8697f5170800eadec';

const baseParams = (over: Partial<OphisEthFlowParams> = {}): OphisEthFlowParams => ({
  chainId: 10,
  buyToken: BUY_TOKEN,
  owner: OWNER,
  sellAmount: 1_000000000000000000n,
  buyAmount: 1_690_000000n,
  fullAppData: FULL_APP_DATA,
  appDataHash: APP_DATA_HASH,
  validTo: 1_893_456_000,
  quoteId: 12345,
  ...over,
});

describe('OPHIS_ETHFLOW_ADDRESSES', () => {
  it('uses the Ophis-operated override for OP and HyperEVM, canonical for CoW-hosted', () => {
    expect(OPHIS_ETHFLOW_ADDRESSES[10]).toBe(OP_ETHFLOW);
    expect(OPHIS_ETHFLOW_ADDRESSES[999]).toBe(HYPEREVM_ETHFLOW);
    expect(OPHIS_ETHFLOW_ADDRESSES[1]).toBe(CANONICAL);
    expect(OPHIS_ETHFLOW_ADDRESSES[8453]).toBe(CANONICAL);
    expect(OPHIS_ETHFLOW_ADDRESSES[42161]).toBe(CANONICAL);
  });

  it('does NOT include MegaETH (4326): no eth-flow contract deployed there', () => {
    expect(OPHIS_ETHFLOW_ADDRESSES[4326]).toBeUndefined();
  });

  it('is frozen (cannot be mutated to redirect native-ETH funds)', () => {
    expect(Object.isFrozen(OPHIS_ETHFLOW_ADDRESSES)).toBe(true);
    expect(() => {
      // @ts-expect-error - readonly at the type level; assert runtime immutability too
      OPHIS_ETHFLOW_ADDRESSES[10] = ZERO;
    }).toThrow();
    expect(OPHIS_ETHFLOW_ADDRESSES[10]).toBe(OP_ETHFLOW);
  });

  it('has a null prototype so a polluted Object.prototype cannot forge an address', () => {
    expect(Object.getPrototypeOf(OPHIS_ETHFLOW_ADDRESSES)).toBeNull();
  });
});

describe('isOphisEthFlowChain / getOphisEthFlowAddress', () => {
  it('is true for supported chains, false for unsupported', () => {
    expect(isOphisEthFlowChain(10)).toBe(true);
    expect(isOphisEthFlowChain(8453)).toBe(true);
    expect(isOphisEthFlowChain(999)).toBe(true);
    expect(isOphisEthFlowChain(4326)).toBe(false); // MegaETH disabled
    expect(isOphisEthFlowChain(12345)).toBe(false); // unknown
  });

  it('returns the address or undefined', () => {
    expect(getOphisEthFlowAddress(10)).toBe(OP_ETHFLOW);
    expect(getOphisEthFlowAddress(4326)).toBeUndefined();
  });

  it('throws on an invalid chainId', () => {
    // @ts-expect-error - exercising the runtime guard
    expect(() => getOphisEthFlowAddress('10')).toThrow(/positive integer/);
    expect(() => getOphisEthFlowAddress(0)).toThrow(/positive integer/);
  });

  it('fails closed for an unsupported chain even if Object.prototype is polluted', () => {
    const polluted = 31337;
    // eslint-disable-next-line no-extend-native
    (Object.prototype as Record<number, unknown>)[polluted] = '0xattacker000000000000000000000000000000000';
    try {
      expect(getOphisEthFlowAddress(polluted)).toBeUndefined();
      expect(isOphisEthFlowChain(polluted)).toBe(false);
    } finally {
      delete (Object.prototype as Record<number, unknown>)[polluted];
    }
  });
});

describe('buildOphisEthFlowOrder - happy path', () => {
  it('assembles the order against the right contract with value === sellAmount', () => {
    const built = buildOphisEthFlowOrder(baseParams());
    expect(built.ethFlowContract).toBe(OP_ETHFLOW);
    expect(built.value).toBe(1_000000000000000000n); // msg.value == sellAmount; eth-flow feeAmount is 0
    expect(built.order.feeAmount).toBe(0n);
    expect(built.order.partiallyFillable).toBe(false);
    expect(built.order.appData).toBe(APP_DATA_HASH);
    expect(built.order.receiver).toBe(OWNER); // pinned to the taker by default
    expect(built.appDataToUpload).toBe(FULL_APP_DATA);
    expect(built.abi).toBe(ETHFLOW_CREATE_ORDER_ABI);
  });

  it('produces a tuple in exact ABI component order', () => {
    const built = buildOphisEthFlowOrder(baseParams());
    expect(built.orderTuple).toEqual([
      BUY_TOKEN, OWNER, 1_000000000000000000n, 1_690_000000n, APP_DATA_HASH, 0n, 1_893_456_000, false, 12345,
    ]);
    expect(ethFlowOrderToTuple(built.order)).toEqual(built.orderTuple);
  });

  it('resolves canonical chains too', () => {
    expect(buildOphisEthFlowOrder(baseParams({ chainId: 8453 })).ethFlowContract).toBe(CANONICAL);
  });

  it('routes to a named custom receiver only via the explicit opt-in', () => {
    const built = buildOphisEthFlowOrder(baseParams({ unsafeCustomReceiver: OTHER }));
    expect(built.order.receiver).toBe(OTHER);
  });

  it('verifies the appData hash binding when a hasher is supplied', () => {
    const good = buildOphisEthFlowOrder(baseParams({ hashAppData: () => APP_DATA_HASH }));
    expect(good.order.appData).toBe(APP_DATA_HASH);
  });
});

describe('buildOphisEthFlowOrder - fund-safety guards', () => {
  it('throws on a chain without native-ETH support (wrap to WETH instead)', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ chainId: 4326 }))).toThrow(/native ETH is not supported/);
    expect(() => buildOphisEthFlowOrder(baseParams({ chainId: 12345 }))).toThrow(/native ETH is not supported/);
  });

  it('throws when the resolved receiver is zero (would send tokens to the eth-flow contract)', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ owner: ZERO }))).toThrow(/non-zero address/);
    expect(() => buildOphisEthFlowOrder(baseParams({ unsafeCustomReceiver: ZERO }))).toThrow(/non-zero address/);
  });

  it('throws when a supplied hasher does not match appDataHash (stale hash => fee drop)', () => {
    const wrong = ('0x' + '22'.repeat(32)) as `0x${string}`;
    expect(() => buildOphisEthFlowOrder(baseParams({ hashAppData: () => wrong }))).toThrow(/does not match/);
  });

  it('throws when appDataHash is not bytes32', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ appDataHash: APP_DATA_HASH.slice(0, 40) as `0x${string}` }))).toThrow(
      /bytes32/,
    );
    expect(() => buildOphisEthFlowOrder(baseParams({ appDataHash: FULL_APP_DATA as unknown as `0x${string}` }))).toThrow(
      /bytes32/,
    );
  });

  it('throws on a non-address buyToken or owner', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ buyToken: 'USDC' as unknown as `0x${string}` }))).toThrow(/buyToken/);
    expect(() => buildOphisEthFlowOrder(baseParams({ owner: '0x123' as unknown as `0x${string}` }))).toThrow(/owner/);
  });

  it('requires a non-empty fullAppData (it must be uploaded for the fee to apply)', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ fullAppData: '' }))).toThrow(/fullAppData/);
    expect(() => buildOphisEthFlowOrder(baseParams({ fullAppData: undefined as unknown as string }))).toThrow(/fullAppData/);
  });

  it('rejects non-bigint or non-positive amounts', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ sellAmount: 1 as unknown as bigint }))).toThrow(/bigint/);
    expect(() => buildOphisEthFlowOrder(baseParams({ sellAmount: 0n }))).toThrow(/> 0/);
    expect(() => buildOphisEthFlowOrder(baseParams({ buyAmount: -5n }))).toThrow(/> 0/);
  });

  it('rejects validTo out of uint32 range and an unsafe/negative quoteId', () => {
    expect(() => buildOphisEthFlowOrder(baseParams({ validTo: 0 }))).toThrow(/uint32/);
    expect(() => buildOphisEthFlowOrder(baseParams({ validTo: 4_294_967_296 }))).toThrow(/uint32/);
    expect(() => buildOphisEthFlowOrder(baseParams({ quoteId: -1 }))).toThrow(/non-negative integer/);
    expect(() => buildOphisEthFlowOrder(baseParams({ quoteId: 1.5 }))).toThrow(/non-negative integer/);
    expect(() => buildOphisEthFlowOrder(baseParams({ quoteId: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(/non-negative integer/);
  });
});
