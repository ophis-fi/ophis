import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeFunctionData, keccak256, stringToHex, type PublicClient } from 'viem';
import { SETTLE_FN } from '../src/cow/settleAbi.js';
import { resolveAppData } from '../src/cow/appDataResolver.js';
import {
  decodeWindow,
  settleDecoderChains,
  isRangeError,
  isDiscoveryOnly,
  runSettleDecoder,
  FEE_VERIFICATION_IMPLEMENTED,
  type OrderTotals,
} from '../src/cow/onchain.js';
import { attributeOrder, DECODER_ETHFLOW_OWNERS } from '../src/fetcher.js';
import { OPHIS_SAFE_ADDRESS } from '../src/safe/addresses.js';

const OPHIS = OPHIS_SAFE_ADDRESS.toLowerCase();
const SHARED_ETHFLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec'; // canonical CoW eth-flow (prod)
const T0 = '0x1111111111111111111111111111111111111111' as const;
const T1 = '0x2222222222222222222222222222222222222222' as const;
const EOA = '0xaaaa000000000000000000000000000000000001' as const;
const TRADER = '0xbbbb000000000000000000000000000000000002' as const;
const OTHER = '0xcccc000000000000000000000000000000000003' as const;

const ophisDoc = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ appCode: 'ophis', metadata: { partnerFee: { volumeBps: 10, recipient: OPHIS }, ...extra } });
// A VALID surplus/PriceImprovement Ophis fee — readVolumeFeeBps returns null for it
// (the volume indexer can't price it); the DECODER must credit 0, not retail.
const surplusDoc = () =>
  JSON.stringify({ appCode: 'ophis', metadata: { partnerFee: { surplusBps: 10, maxVolumeBps: 100, recipient: OPHIS } } });
const nonOphisDoc = () => JSON.stringify({ appCode: 'someoneelse', metadata: {} });
const hashOf = (doc: string) => keccak256(stringToHex(doc));

// getOrderTotals mock: CoW order total per uid, or null to keep the per-fill floor.
const totalsFn =
  (byUid: Record<string, OrderTotals> = {}) =>
  async (_chainId: number, uid: `0x${string}`): Promise<OrderTotals | null> =>
    byUid[uid] ?? null;

afterEach(() => vi.unstubAllGlobals());

// Stub global fetch so resolveAppData(hash) returns the doc whose keccak matches.
function stubAppDataApi(docsByHash: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const hash = url.split('/').pop() ?? '';
      const doc = docsByHash[hash];
      if (!doc) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, json: async () => ({ fullAppData: doc }) } as unknown as Response;
    }),
  );
}

function uid(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(2, '0').repeat(56)}` as `0x${string}`;
}

interface TupleTrade {
  sellTokenIndex: bigint;
  buyTokenIndex: bigint;
  receiver: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  appData: `0x${string}`;
  feeAmount: bigint;
  flags: bigint;
  executedAmount: bigint;
  signature: `0x${string}`;
}
const mkTrade = (o: Partial<TupleTrade>): TupleTrade => ({
  sellTokenIndex: 0n,
  buyTokenIndex: 1n,
  receiver: EOA,
  sellAmount: 1_000n,
  buyAmount: 2_000n,
  validTo: 0,
  appData: ('0x' + '00'.repeat(32)) as `0x${string}`,
  feeAmount: 0n,
  flags: 0n,
  executedAmount: 1_000n,
  signature: '0x',
  ...o,
});

function encodeSettle(tokens: readonly `0x${string}`[], trades: readonly TupleTrade[]): `0x${string}` {
  return encodeFunctionData({
    abi: [SETTLE_FN],
    functionName: 'settle',
    args: [tokens, tokens.map(() => 1n), trades, [[], [], []]],
  });
}

interface TradeLogInput {
  owner: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  orderUid: `0x${string}`;
  logIndex: number;
}
const mkLog = (o: TradeLogInput) => ({
  args: { ...o, feeAmount: 0n },
  transactionHash: '0xtx' as `0x${string}`,
  blockNumber: 100n,
  logIndex: o.logIndex,
});

function mockClient(settleCalldata: `0x${string}`): PublicClient {
  return {
    getTransaction: vi.fn(async () => ({ input: settleCalldata })),
    getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
  } as unknown as PublicClient;
}

describe('B1 money-path safety gate', () => {
  // TRIPWIRE: the decoder must NOT credit rebate volume until the settlement's
  // on-chain fee transfer to the Ophis Safe is verified (ToB B1). Flipping this
  // constant requires the fee-verification fix + a Codex review, which must update
  // this test deliberately. Do not "fix" it by editing the expectation alone.
  it('stays hard-disabled until on-chain fee verification lands', () => {
    expect(FEE_VERIFICATION_IMPLEMENTED).toBe(false);
  });

  it('writes nothing even when SETTLE_DECODER_CHAINS is set (and discovery-only is off)', async () => {
    const prev = process.env.SETTLE_DECODER_CHAINS;
    const prevDisc = process.env.SETTLE_DECODER_DISCOVERY_ONLY;
    process.env.SETTLE_DECODER_CHAINS = '8453';
    delete process.env.SETTLE_DECODER_DISCOVERY_ONLY; // fee-crediting path stays hard-disabled
    const upsertTrades = vi.fn(async () => {
      throw new Error('upsert must not be called while the decoder is hard-disabled');
    });
    const n = await runSettleDecoder({ sql: (async () => []) as never, upsertTrades });
    expect(n).toBe(0);
    expect(upsertTrades).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.SETTLE_DECODER_CHAINS;
    else process.env.SETTLE_DECODER_CHAINS = prev;
    if (prevDisc !== undefined) process.env.SETTLE_DECODER_DISCOVERY_ONLY = prevDisc;
  });
});

describe('isDiscoveryOnly', () => {
  it('is true only when SETTLE_DECODER_DISCOVERY_ONLY === "true"', () => {
    const prev = process.env.SETTLE_DECODER_DISCOVERY_ONLY;
    process.env.SETTLE_DECODER_DISCOVERY_ONLY = 'true';
    expect(isDiscoveryOnly()).toBe(true);
    process.env.SETTLE_DECODER_DISCOVERY_ONLY = 'false';
    expect(isDiscoveryOnly()).toBe(false);
    delete process.env.SETTLE_DECODER_DISCOVERY_ONLY;
    expect(isDiscoveryOnly()).toBe(false);
    if (prev !== undefined) process.env.SETTLE_DECODER_DISCOVERY_ONLY = prev;
  });
});

describe('settleDecoderChains / isRangeError', () => {
  it('parses SETTLE_DECODER_CHAINS CSV, empty = off', () => {
    const prev = process.env.SETTLE_DECODER_CHAINS;
    process.env.SETTLE_DECODER_CHAINS = '';
    expect(settleDecoderChains()).toEqual([]);
    process.env.SETTLE_DECODER_CHAINS = '8453, 10';
    expect(settleDecoderChains()).toEqual([8453, 10]);
    if (prev === undefined) delete process.env.SETTLE_DECODER_CHAINS;
    else process.env.SETTLE_DECODER_CHAINS = prev;
  });
  it('detects getLogs range/limit errors', () => {
    expect(isRangeError(new Error('block range too large'))).toBe(true);
    expect(isRangeError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeError(new Error('-32602 invalid params'))).toBe(true);
    expect(isRangeError(new Error('nonce too low'))).toBe(false);
  });
});

describe('resolveAppData (re-hash guard)', () => {
  it('returns the doc when keccak matches the requested hash', async () => {
    const doc = ophisDoc();
    const h = hashOf(doc);
    stubAppDataApi({ [h]: doc });
    expect(await resolveAppData(8453, h)).toBe(doc);
  });
  it('returns null when the returned doc does NOT hash to the requested hash', async () => {
    const doc = ophisDoc();
    const wrongHash = hashOf(nonOphisDoc()); // ask for a different hash than the doc produces
    stubAppDataApi({ [wrongHash]: doc });
    expect(await resolveAppData(8453, wrongHash)).toBeNull();
  });
  it('returns null on 404 (unpinned)', async () => {
    stubAppDataApi({}); // any hash -> 404
    expect(await resolveAppData(8453, hashOf(ophisDoc()))).toBeNull();
  });
  it('throws on a transient 500 (caller must not advance the cursor)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    await expect(resolveAppData(8453, hashOf(ophisDoc()))).rejects.toThrow('app_data 500');
  });
});

describe('attributeOrder with DECODER_ETHFLOW_OWNERS (shared eth-flow coverage)', () => {
  const base = {
    sellToken: T0,
    buyToken: T1,
    executedSell: 1_000n,
    executedBuy: 2_000n,
    tradeUid: uid(1),
    chainId: 8453,
    blockNumber: 100n,
    blockTimestamp: new Date(0),
  };
  it('attributes a SHARED eth-flow order to its receiver, not the router', () => {
    const t = attributeOrder(
      JSON.parse(ophisDoc()),
      { ...base, owner: SHARED_ETHFLOW, receiver: TRADER },
      DECODER_ETHFLOW_OWNERS,
    );
    expect(t?.wallet).toBe(TRADER);
  });
  it('attributes a normal EOA order to its owner', () => {
    const t = attributeOrder(JSON.parse(ophisDoc()), { ...base, owner: EOA, receiver: EOA }, DECODER_ETHFLOW_OWNERS);
    expect(t?.wallet).toBe(EOA);
  });
  it('drops a non-Ophis order', () => {
    const t = attributeOrder(JSON.parse(nonOphisDoc()), { ...base, owner: EOA, receiver: EOA }, DECODER_ETHFLOW_OWNERS);
    expect(t).toBeNull();
  });
  it('drops a shared eth-flow order whose receiver is the router itself', () => {
    const t = attributeOrder(
      JSON.parse(ophisDoc()),
      { ...base, owner: SHARED_ETHFLOW, receiver: SHARED_ETHFLOW },
      DECODER_ETHFLOW_OWNERS,
    );
    expect(t).toBeNull();
  });
});

describe('decodeWindow (decode -> align -> attribute, end to end, no DB)', () => {
  it('lands exactly the Ophis trades (EOA + shared eth-flow), drops non-Ophis, UID = event orderUid', async () => {
    const docA = ophisDoc();
    const docB = ophisDoc({ note: 'ethflow' }); // distinct doc/hash for the eth-flow trade
    const hA = hashOf(docA);
    const hB = hashOf(docB);
    const hC = hashOf(nonOphisDoc());
    stubAppDataApi({ [hA]: docA, [hB]: docB, [hC]: nonOphisDoc() });

    const trades = [
      mkTrade({ appData: hA, receiver: EOA }), // EOA Ophis
      mkTrade({ appData: hB, receiver: TRADER }), // shared eth-flow Ophis (owner is the router)
      mkTrade({ sellTokenIndex: 1n, buyTokenIndex: 0n, appData: hC, receiver: OTHER }), // non-Ophis
    ];
    const calldata = encodeSettle([T0, T1], trades);

    const logs = [
      mkLog({ owner: EOA, sellToken: T0, buyToken: T1, sellAmount: 1_000n, buyAmount: 2_000n, orderUid: uid(1), logIndex: 0 }),
      mkLog({ owner: SHARED_ETHFLOW, sellToken: T0, buyToken: T1, sellAmount: 5_000n, buyAmount: 9_000n, orderUid: uid(2), logIndex: 1 }),
      mkLog({ owner: OTHER, sellToken: T1, buyToken: T0, sellAmount: 7_000n, buyAmount: 3_000n, orderUid: uid(3), logIndex: 2 }),
    ];

    const rows = await decodeWindow(
      8453,
      mockClient(calldata),
      logs as never,
      totalsFn({ [uid(2)]: { executedSell: 50_000n, executedBuy: 90_000n } }),
    );
    expect(rows).toHaveLength(2);
    const byUid = Object.fromEntries(rows.map((r) => [r.tradeUid, r]));
    expect(byUid[uid(1)]?.wallet).toBe(EOA);
    expect(byUid[uid(1)]?.sellAmount).toBe(1_000n); // null order-total -> per-fill event floor
    expect(byUid[uid(2)]?.wallet).toBe(TRADER); // eth-flow attributed to receiver
    expect(byUid[uid(2)]?.sellAmount).toBe(50_000n); // order TOTAL (getOrder), not the single fill
    expect(byUid[uid(3)]).toBeUndefined(); // non-Ophis dropped
  });

  it('drops only the misaligned trade when the token-index cross-check fails', async () => {
    const docA = ophisDoc();
    const hA = hashOf(docA);
    stubAppDataApi({ [hA]: docA });
    // trade 0 claims sellTokenIndex 0 (=T0) but the log says the sell token is T1 -> mismatch -> drop.
    const trades = [mkTrade({ appData: hA, receiver: EOA }), mkTrade({ appData: hA, receiver: TRADER })];
    const calldata = encodeSettle([T0, T1], trades);
    const logs = [
      mkLog({ owner: EOA, sellToken: T1, buyToken: T0, sellAmount: 1n, buyAmount: 2n, orderUid: uid(1), logIndex: 0 }), // mismatched
      mkLog({ owner: SHARED_ETHFLOW, sellToken: T0, buyToken: T1, sellAmount: 3n, buyAmount: 4n, orderUid: uid(2), logIndex: 1 }), // aligned
    ];
    const rows = await decodeWindow(8453, mockClient(calldata), logs as never, totalsFn());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tradeUid).toBe(uid(2));
    expect(rows[0]?.wallet).toBe(TRADER);
  });

  it('credits a surplus/PI Ophis fee as 0, NOT retail (null->0 forgery guard, Codex #1)', async () => {
    const doc = surplusDoc();
    const h = hashOf(doc);
    stubAppDataApi({ [h]: doc });
    const calldata = encodeSettle([T0, T1], [mkTrade({ appData: h, receiver: EOA })]);
    const logs = [mkLog({ owner: EOA, sellToken: T0, buyToken: T1, sellAmount: 1_000n, buyAmount: 2_000n, orderUid: uid(1), logIndex: 0 })];
    const rows = await decodeWindow(8453, mockClient(calldata), logs as never, totalsFn());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.volumeFeeBps).toBe(0); // NOT null (null would COALESCE to retail in accrual)
  });

  it('discoveryOnly forces every row to a non-creditable 0 + fee_verified=false (catalog-only)', async () => {
    const docA = ophisDoc(); // partnerFee volumeBps:10 -> a POSITIVE fee in normal mode
    const hA = hashOf(docA);
    stubAppDataApi({ [hA]: docA });
    const calldata = encodeSettle([T0, T1], [mkTrade({ appData: hA, receiver: EOA })]);
    const logs = [mkLog({ owner: EOA, sellToken: T0, buyToken: T1, sellAmount: 1_000n, buyAmount: 2_000n, orderUid: uid(1), logIndex: 0 })];
    // normal mode: the real Ophis fee, marked verified (API-attribution default)
    const normal = await decodeWindow(8453, mockClient(calldata), logs as never, totalsFn());
    expect(normal[0]?.volumeFeeBps).toBe(10);
    expect(normal[0]?.feeVerified).toBe(true);
    // discovery-only: same trade, forced to a provisional 0 (credits nothing) + unverified
    // (the API fetcher can later upgrade it to the owner-allowlist-confirmed fee).
    const disc = await decodeWindow(8453, mockClient(calldata), logs as never, totalsFn(), true);
    expect(disc[0]?.volumeFeeBps).toBe(0);
    expect(disc[0]?.feeVerified).toBe(false);
  });

  it('aborts the window (throws) on a transient getTransaction failure (Codex #3)', async () => {
    stubAppDataApi({});
    const badClient = {
      getTransaction: vi.fn(async () => {
        throw new Error('rpc 503');
      }),
      getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
    } as unknown as PublicClient;
    const logs = [mkLog({ owner: EOA, sellToken: T0, buyToken: T1, sellAmount: 1n, buyAmount: 2n, orderUid: uid(1), logIndex: 0 })];
    await expect(decodeWindow(8453, badClient, logs as never, totalsFn())).rejects.toThrow('rpc 503');
  });

  it('aborts the window (throws) on a transient getOrder failure (Codex #2/#3)', async () => {
    const doc = ophisDoc();
    const h = hashOf(doc);
    stubAppDataApi({ [h]: doc });
    const calldata = encodeSettle([T0, T1], [mkTrade({ appData: h, receiver: EOA })]);
    const logs = [mkLog({ owner: EOA, sellToken: T0, buyToken: T1, sellAmount: 1_000n, buyAmount: 2_000n, orderUid: uid(1), logIndex: 0 })];
    const failingTotals = async () => {
      throw new Error('order 500');
    };
    await expect(decodeWindow(8453, mockClient(calldata), logs as never, failingTotals)).rejects.toThrow('order 500');
  });
});
