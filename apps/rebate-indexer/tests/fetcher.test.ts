import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const COW_FAKE_BASE = 'https://api.cow.fi';

const sampleTrade = (uid: string, owner: string, sell = '1000000000000000000', buy = '2500000000') => ({
  blockNumber: 35_000_000,
  logIndex: 1,
  orderUid: uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: sell,
  buyAmount: buy,
  txHash: '0x' + '11'.repeat(32),
});

const sampleOrder = (uid: string, owner: string, appCode = 'ophis') => ({
  uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: '1000000000000000000',
  buyAmount: '2500000000',
  appData: '0xabc',
  fullAppData: JSON.stringify({ appCode, metadata: { partnerFee: { recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' } } }),
  creationDate: '2026-05-01T12:00:00Z',
  status: 'fulfilled',
  executedSellAmount: '1000000000000000000',
  executedBuyAmount: '2500000000',
});

// Build an order whose appData carries an arbitrary structure (for widget / referrer cases).
const orderWithAppData = (uid: string, owner: string, appDataObj: object) => ({
  uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: '1000000000000000000',
  buyAmount: '2500000000',
  appData: '0xabc',
  fullAppData: JSON.stringify(appDataObj),
  creationDate: '2026-05-01T12:00:00Z',
  status: 'fulfilled',
  executedSellAmount: '1000000000000000000',
  executedBuyAmount: '2500000000',
});
// A real Ophis Volume partner fee: recipient = the Ophis Safe + a flat volume bps (reads as
// volumeFeeBps > 0), which the widget-fallback attribution now requires.
const OPHIS_FEE = { recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8', bps: 5 };

// Hoisted to the top level (vitest 4 warns — and will error in a future version —
// if vi.hoisted() is nested inside describe()). It still executes before imports.
const handlers = vi.hoisted(() => ({
  trades: vi.fn(),
  order: vi.fn(),
  blockTime: vi.fn(),
}));

describe('fetcher.fetchChainTrades', () => {
  const server = setupServer(
    http.get(`${COW_FAKE_BASE}/xdai/api/v2/trades`, () => HttpResponse.json(handlers.trades())),
    http.get(`${COW_FAKE_BASE}/xdai/api/v1/orders/:uid`, ({ params }) =>
      HttpResponse.json(handlers.order(params.uid))),
  );
  beforeEach(() => {
    process.env.COW_API_BASE = COW_FAKE_BASE;
    server.listen();
  });
  afterEach(() => {
    server.resetHandlers();
    server.close();
  });

  it('skips trades whose order has appCode != ophis/greg', async () => {
    const ophisUid = '0x' + '0a'.repeat(56);
    const otherUid = '0x' + '0b'.repeat(56);
    handlers.trades.mockReturnValue([sampleTrade(ophisUid, '0xa'.padEnd(42, '0')), sampleTrade(otherUid, '0xb'.padEnd(42, '0'))]);
    handlers.order.mockImplementation((uid: string) => uid === ophisUid
      ? sampleOrder(ophisUid, '0xa'.padEnd(42, '0'), 'ophis')
      : sampleOrder(otherUid, '0xb'.padEnd(42, '0'), 'someoneelse'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, '0xa'.padEnd(42, '0') as `0x${string}`, {});
    expect(rows.map((r) => r.tradeUid)).toEqual([ophisUid]);
    expect(rows[0]!.appCode).toBe('ophis');
    // block_timestamp now comes from the order's creationDate.
    expect(rows[0]!.blockTimestamp.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  it('indexes Ophis orders regardless of appCode casing (case-insensitive; stores lowercase)', async () => {
    // Regression: the widget/MCP and the frontend fallback emit appCode 'Ophis' (capital). A
    // case-sensitive match would drop these orders and silently forfeit their rebates.
    const upperUid = '0x' + '1c'.repeat(56);
    const gregUid = '0x' + '1d'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(upperUid, owner), sampleTrade(gregUid, owner)]);
    handlers.order.mockImplementation((uid: string) => uid === upperUid
      ? sampleOrder(upperUid, owner, 'Ophis') // widget/MCP/frontend-fallback casing
      : sampleOrder(gregUid, owner, 'GREG'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows.map((r) => r.tradeUid).sort()).toEqual([upperUid, gregUid].sort());
    // stored normalized to lowercase so downstream grouping/typing stays consistent
    expect(rows.map((r) => r.appCode).sort()).toEqual(['greg', 'ophis']);
  });

  // ---- eth-flow attribution: owner = the Ophis eth-flow contract, real trader = receiver ----
  // Detection is owner-based (the Ophis eth-flow contract address), so it is chain-agnostic;
  // these run on the mocked chain-100 endpoints to validate the attribution logic.
  const OP_ETHFLOW = '0x764fe4aa1ff493cf39931c7923c8ff5837596504'; // Optimism Ophis eth-flow contract
  const orderWithReceiver = (uid: string, owner: string, receiver: string | null, appCode = 'ophis') => ({
    uid,
    owner,
    receiver,
    sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
    buyToken: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    sellAmount: '1000000000000000000',
    buyAmount: '2500000000',
    appData: '0xabc',
    fullAppData: JSON.stringify({ appCode, metadata: { partnerFee: OPHIS_FEE } }),
    creationDate: '2026-05-01T12:00:00Z',
    status: 'fulfilled',
    executedSellAmount: '1000000000000000000',
    executedBuyAmount: '2500000000',
  });

  it('attributes an eth-flow trade (owner = the Ophis eth-flow contract) to the order receiver, not the contract', async () => {
    const uid = '0x' + 'e0'.repeat(56);
    const user = '0xc'.padEnd(42, '0'); // the real trader (eth-flow receiver)
    handlers.trades.mockReturnValue([sampleTrade(uid, OP_ETHFLOW)]);
    handlers.order.mockImplementation(() => orderWithReceiver(uid, OP_ETHFLOW, user, 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, OP_ETHFLOW as `0x${string}`, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wallet).toBe(user); // attributed to the receiver, NOT the eth-flow contract
    expect(rows[0]!.wallet).not.toBe(OP_ETHFLOW);
  });

  it('attributes a non-eth-flow trade to its on-chain owner (receiver ignored)', async () => {
    const uid = '0x' + 'e1'.repeat(56);
    const owner = '0xb'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockImplementation(() => orderWithReceiver(uid, owner, '0xc'.padEnd(42, '0'), 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wallet).toBe(owner); // a normal order keeps owner, ignores receiver
  });

  it('skips an eth-flow trade with no usable receiver rather than crediting the contract', async () => {
    const uid = '0x' + 'e2'.repeat(56);
    handlers.trades.mockReturnValue([sampleTrade(uid, OP_ETHFLOW)]);
    handlers.order.mockImplementation(() => orderWithReceiver(uid, OP_ETHFLOW, null, 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, OP_ETHFLOW as `0x${string}`, {});
    expect(rows).toHaveLength(0); // no usable receiver -> skipped, the contract is never credited
  });

  it('skips an eth-flow trade whose receiver is itself an eth-flow contract (never re-credits the router)', async () => {
    const uid = '0x' + 'e3'.repeat(56);
    handlers.trades.mockReturnValue([sampleTrade(uid, OP_ETHFLOW)]);
    // degenerate order with receiver == the eth-flow contract: must NOT attribute back to it
    handlers.order.mockImplementation(() => orderWithReceiver(uid, OP_ETHFLOW, OP_ETHFLOW, 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, OP_ETHFLOW as `0x${string}`, {});
    expect(rows).toHaveLength(0);
  });

  it('recognizes a widget order via metadata.widget.appCode and attributes the top-level appCode as the integrator referral', async () => {
    // Widget embeds promote the integrator's appCode to the top level and demote 'ophis' to
    // metadata.widget.appCode. The order must still be recognized, and the integrator earns via
    // their top-level appCode (registered as a ref code).
    const uid = '0x' + '2a'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'acme-dapp',
      metadata: { widget: { appCode: 'ophis' }, partnerFee: OPHIS_FEE },
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.appCode).toBe('ophis'); // stored as the matched Ophis code
    expect(rows[0]!.appdataRefCode).toBe('acme-dapp');
  });

  it('prefers an explicit ophisReferrer over the widget top-level appCode', async () => {
    const uid = '0x' + '2b'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'acme-dapp',
      metadata: { widget: { appCode: 'ophis' }, ophisReferrer: { code: 'realref' }, partnerFee: OPHIS_FEE },
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows[0]!.appdataRefCode).toBe('realref');
  });

  it('does NOT attribute an ophisReferrer code when no real Ophis volume fee was paid (forged / zero-fee)', async () => {
    // Symmetric with the widget-arm gate: a recognized order carrying ophisReferrer.code but NO
    // volume bps reads as volumeFeeBps = 0, so the ophisReferrer arm must NOT attribute either —
    // closing the surplus/PI-NULL retail-COALESCE forge on the explicit-referrer path too.
    const uid = '0x' + '2f'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'ophis',
      metadata: { ophisReferrer: { code: 'realref' }, partnerFee: { recipient: OPHIS_FEE.recipient } }, // recipient, no bps
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows).toHaveLength(1); // recognized via top-level appCode (trader volume still tracked)
    expect(rows[0]!.appCode).toBe('ophis');
    expect(rows[0]!.appdataRefCode).toBeNull(); // ophisReferrer gated out by volumeFeeBps = 0
  });

  it('does NOT attribute an ophisReferrer code on a surplus/PI fee shape (volumeFeeBps = NULL — the accepted asymmetry)', async () => {
    // The load-bearing NULL case: a valid surplus/price-improvement partnerFee to the Ophis
    // recipient reads volumeFeeBps = NULL (the volume-derived indexer can't price it). Gate A
    // intentionally DROPS it on the attribution path (Ophis never emits surplus/PI, so a NULL on a
    // fresh order is forge-or-unprocessed), while the trader-volume matview KEEPS NULL. This pins
    // that the explicit-referrer arm excludes NULL, not just 0.
    const uid = '0x' + '30'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'ophis',
      metadata: {
        ophisReferrer: { code: 'realref' },
        partnerFee: { surplusBps: 10, maxVolumeBps: 50, recipient: OPHIS_FEE.recipient }, // surplus/PI -> NULL
      },
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows).toHaveLength(1); // recognized
    expect(rows[0]!.volumeFeeBps).toBeNull(); // surplus/PI reads NULL
    expect(rows[0]!.appdataRefCode).toBeNull(); // Gate A excludes NULL on the attribution path
  });

  it('does not treat the reserved Ophis appCode as a referral for a non-overridden widget order', async () => {
    const uid = '0x' + '2c'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'ophis', // integrator did not override -> Ophis default
      metadata: { widget: { appCode: 'ophis' }, partnerFee: OPHIS_FEE },
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows[0]!.appCode).toBe('ophis');
    expect(rows[0]!.appdataRefCode).toBeNull();
  });

  it('recognizes a widget order but drops an invalid top-level appCode as the referral candidate', async () => {
    const uid = '0x' + '2d'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'Acme Dapp!', // spaces + punctuation -> fails the ref-code grammar
      metadata: { widget: { appCode: 'ophis' }, partnerFee: OPHIS_FEE },
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows).toHaveLength(1); // still recognized via widget.appCode
    expect(rows[0]!.appCode).toBe('ophis');
    expect(rows[0]!.appdataRefCode).toBeNull();
  });

  it('does NOT attribute the widget appCode when no real Ophis volume fee was paid (forged / zero-fee)', async () => {
    // Security regression: a forged widget order (widget.appCode='ophis', top-level = a would-be
    // registered code) carrying the Ophis recipient but NO volume bps reads as volumeFeeBps = 0, so
    // the fallback must NOT attribute — a referral can't earn a share of a fee that was never paid.
    const uid = '0x' + '2e'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([sampleTrade(uid, owner)]);
    handlers.order.mockReturnValue(orderWithAppData(uid, owner, {
      appCode: 'acme-dapp',
      metadata: { widget: { appCode: 'ophis' }, partnerFee: { recipient: OPHIS_FEE.recipient } }, // recipient, no bps
    }));
    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    expect(rows).toHaveLength(1); // recognized via widget.appCode (trader volume still tracked)
    expect(rows[0]!.appCode).toBe('ophis');
    expect(rows[0]!.appdataRefCode).toBeNull(); // no confirmed Ophis volume fee -> no integrator attribution
  });

  it('paginates until the API returns fewer than limit rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => sampleTrade('0x' + i.toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    const page2 = Array.from({ length: 17 },   (_, i) => sampleTrade('0x' + (1000 + i).toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    let call = 0;
    handlers.trades.mockImplementation(() => (call++ === 0 ? page1 : page2));
    handlers.order.mockImplementation((uid: string) => sampleOrder(uid, '0xa'.padEnd(42, '0'), 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, '0xa'.padEnd(42, '0') as `0x${string}`, {});
    expect(rows).toHaveLength(1017);
  });

  it('records terminal orders (fulfilled/cancelled/expired) with executed amounts, skips active ones', async () => {
    const fulfilledUid = '0x' + '0e'.repeat(56);
    const cancelledUid = '0x' + '0f'.repeat(56);
    const openUid = '0x' + '1a'.repeat(56);
    const owner = '0xa'.padEnd(42, '0');
    handlers.trades.mockReturnValue([
      sampleTrade(fulfilledUid, owner, '1'), // fill amount '1' differs from executed total
      sampleTrade(cancelledUid, owner, '1'),
      sampleTrade(openUid, owner, '1'),
    ]);
    handlers.order.mockImplementation((uid: string) => {
      const base = sampleOrder(uid, owner, 'ophis');
      if (uid === fulfilledUid) return { ...base, status: 'fulfilled', executedSellAmount: '9999', executedBuyAmount: '8888' };
      if (uid === cancelledUid) return { ...base, status: 'cancelled', executedSellAmount: '500', executedBuyAmount: '400' }; // partial fill, then cancelled
      return { ...base, status: 'open' }; // still active
    });

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    const byUid = Object.fromEntries(rows.map((r) => [r.tradeUid, r]));
    expect(Object.keys(byUid).sort()).toEqual([cancelledUid, fulfilledUid].sort()); // 'open' skipped
    expect(byUid[fulfilledUid]!.sellAmount).toBe(9999n); // executed total, not the fill's '1'
    expect(byUid[fulfilledUid]!.buyAmount).toBe(8888n);
    expect(byUid[cancelledUid]!.sellAmount).toBe(500n); // partial settled volume of a cancelled order is counted
  });

  it('extracts + clamps appData partnerFee.volumeBps per trade (5/10/1, inflated->retail, absent->null, array shape)', async () => {
    const owner = '0xa'.padEnd(42, '0');
    const REC = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
    const mk = (n: number): string => '0x' + n.toString(16).padStart(112, '0');
    const ATTACKER = '0x' + 'de'.repeat(20);
    const uids = {
      sdk: mk(0x51), retail: mk(0x52), stable: mk(0x53),
      inflated: mk(0x54), absent: mk(0x55), arr: mk(0x56), zero: mk(0x57),
      decoy: mk(0x58), wrongRecipient: mk(0x59),
      legacyBps: mk(0x5a), surplusNotVolume: mk(0x5b), piNotVolume: mk(0x5c),
      cappedBps: mk(0x5d), cappedVolumeBps: mk(0x5e), bothAliases: mk(0x5f),
      malformedSurplus: mk(0x60), mixedSurplusVolume: mk(0x61),
    };
    handlers.trades.mockReturnValue(Object.values(uids).map((u) => sampleTrade(u, owner)));
    const withFee = (uid: string, pf: unknown) => ({
      ...sampleOrder(uid, owner, 'ophis'),
      fullAppData: JSON.stringify({ appCode: 'ophis', metadata: { partnerFee: pf } }),
    });
    handlers.order.mockImplementation((uid: string) => {
      switch (uid) {
        case uids.sdk: return withFee(uid, { volumeBps: 5, recipient: REC });
        case uids.retail: return withFee(uid, { volumeBps: 10, recipient: REC });
        case uids.stable: return withFee(uid, { volumeBps: 1, recipient: REC });
        case uids.inflated: return withFee(uid, { volumeBps: 50, recipient: REC }); // crafted -> clamp to 10
        case uids.absent: return withFee(uid, { recipient: REC }); // no volumeBps -> 0 (no Ophis fee; NOT retail default)
        case uids.arr: return withFee(uid, [{ volumeBps: 5, recipient: REC }]); // array partnerFee shape
        case uids.zero: return withFee(uid, { volumeBps: 0, recipient: REC }); // <1 -> 0
        // DECOY: attacker entry first (higher bps), real Ophis entry second. Must
        // ignore the decoy and use the Ophis-recipient rate (5).
        case uids.decoy: return withFee(uid, [{ volumeBps: 10, recipient: ATTACKER }, { volumeBps: 5, recipient: REC }]);
        // Fee paid to a non-Ophis recipient only -> not our fee -> 0 (NOT the retail default).
        case uids.wrongRecipient: return withFee(uid, { volumeBps: 5, recipient: ATTACKER });
        // Legacy Volume shape { bps } (no volumeBps) -> backend maps to Volume -> read it.
        case uids.legacyBps: return withFee(uid, { bps: 5, recipient: REC });
        // A VALID surplus / price-improvement Ophis fee: real fee, but the volume-
        // derived indexer can't compute it -> null (retail default), NOT 0.
        case uids.surplusNotVolume: return withFee(uid, { surplusBps: 10, maxVolumeBps: 50, recipient: REC });
        case uids.piNotVolume: return withFee(uid, { priceImprovementBps: 2500, maxVolumeBps: 50, recipient: REC });
        // Capped { bps, maxVolumeBps } / { volumeBps, maxVolumeBps } are NOT flat Volume
        // fees (the backend Errs on them) -> credit zero (0), not the retail default.
        case uids.cappedBps: return withFee(uid, { bps: 5, maxVolumeBps: 50, recipient: REC });
        case uids.cappedVolumeBps: return withFee(uid, { volumeBps: 5, maxVolumeBps: 50, recipient: REC });
        // Both volumeBps AND legacy bps present -> matches no backend Volume arm -> 0.
        case uids.bothAliases: return withFee(uid, { volumeBps: 5, bps: 10, recipient: REC });
        // MALFORMED surplus-ish shapes (backend-rejected) -> 0, NOT the retail default:
        // missing maxVolumeBps, and surplus mixed with a volume rate.
        case uids.malformedSurplus: return withFee(uid, { surplusBps: 10, recipient: REC });
        case uids.mixedSurplusVolume: return withFee(uid, { surplusBps: 10, volumeBps: 5, maxVolumeBps: 50, recipient: REC });
        default: return sampleOrder(uid, owner, 'ophis');
      }
    });

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    const byUid = Object.fromEntries(rows.map((r) => [r.tradeUid, r.volumeFeeBps]));
    expect(byUid[uids.sdk]).toBe(5);
    expect(byUid[uids.retail]).toBe(10);
    expect(byUid[uids.stable]).toBe(1);
    expect(byUid[uids.inflated]).toBe(10); // clamped to the retail ceiling: can't inflate the rebate base
    expect(byUid[uids.arr]).toBe(5);
    expect(byUid[uids.decoy]).toBe(5); // decoy entry ignored; only the Ophis-recipient fee counts
    expect(byUid[uids.legacyBps]).toBe(5); // legacy { bps } Volume shape read
    // A VALID surplus/PI Ophis fee -> null (real fee, can't compute -> retail default).
    expect(byUid[uids.surplusNotVolume]).toBeNull();
    expect(byUid[uids.piNotVolume]).toBeNull();
    // NO settled Ophis fee at all -> 0 (credit zero), NOT null (which would COALESCE
    // to the retail default and over-credit a fee that was never collected).
    expect(byUid[uids.absent]).toBe(0); // Ophis recipient but no volumeBps/bps
    expect(byUid[uids.zero]).toBe(0); // volumeBps:0 (< 1)
    expect(byUid[uids.wrongRecipient]).toBe(0); // fee not to Ophis
    expect(byUid[uids.cappedBps]).toBe(0); // { bps, maxVolumeBps } rejected by backend
    expect(byUid[uids.cappedVolumeBps]).toBe(0); // { volumeBps, maxVolumeBps } rejected
    expect(byUid[uids.bothAliases]).toBe(0); // { volumeBps, bps } matches no backend arm
    expect(byUid[uids.malformedSurplus]).toBe(0); // surplus w/o maxVolumeBps: rejected -> 0, not retail
    expect(byUid[uids.mixedSurplusVolume]).toBe(0); // surplus + volume mixed: rejected -> 0
  });

  it('decodes the integrator OWN-fee from a stacked partnerFee array (the non-Ophis entry) and clamps it', async () => {
    // Own-fee stacking: an integrator puts THEIR OWN recipient entry next to the Ophis
    // base entry in the partnerFee array. The fetcher must decode that non-Ophis entry
    // into ownFeeBps + ownFeeRecipient (reporting-only, for GET /earnings/:appCode)
    // WITHOUT disturbing the Ophis fee (volumeFeeBps, read from the Ophis-recipient entry).
    const owner = '0xa'.padEnd(42, '0');
    const OPHIS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'; // the Ophis Safe (base fee)
    const INTEGRATOR = '0x' + 'c1'.repeat(20); // the integrator's own-fee recipient
    const mk = (n: number): string => '0x' + n.toString(16).padStart(112, '0');
    const uids = { stacked: mk(0x71), ophisOnly: mk(0x72), inflated: mk(0x73), single: mk(0x74) };
    handlers.trades.mockReturnValue(Object.values(uids).map((u) => sampleTrade(u, owner)));
    const withFee = (uid: string, pf: unknown) => ({
      ...sampleOrder(uid, owner, 'ophis'),
      fullAppData: JSON.stringify({ appCode: 'ophis', metadata: { partnerFee: pf } }),
    });
    handlers.order.mockImplementation((uid: string) => {
      switch (uid) {
        // Ophis base entry + the integrator's stacked own entry -> own-fee 25 bps to INTEGRATOR.
        case uids.stacked: return withFee(uid, [{ volumeBps: 10, recipient: OPHIS }, { volumeBps: 25, recipient: INTEGRATOR }]);
        // Only the Ophis entry -> no own-fee at all.
        case uids.ophisOnly: return withFee(uid, [{ volumeBps: 10, recipient: OPHIS }]);
        // A crafted huge own-fee is CLAMPED to OWN_FEE_MAX_BPS (100, the appData
        // per-entry schema max) - appData is untrusted.
        case uids.inflated: return withFee(uid, [{ volumeBps: 10, recipient: OPHIS }, { volumeBps: 999999, recipient: INTEGRATOR }]);
        // A single (non-array) non-Ophis entry is still decoded as the own-fee.
        case uids.single: return withFee(uid, { volumeBps: 30, recipient: INTEGRATOR });
        default: return sampleOrder(uid, owner, 'ophis');
      }
    });

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, owner as `0x${string}`, {});
    const byUid = Object.fromEntries(rows.map((r) => [r.tradeUid, r]));
    expect(byUid[uids.stacked]!.ownFeeBps).toBe(25);
    expect(byUid[uids.stacked]!.ownFeeRecipient).toBe(INTEGRATOR.toLowerCase());
    expect(byUid[uids.stacked]!.volumeFeeBps).toBe(10); // Ophis base fee unaffected by the own-fee decode
    expect(byUid[uids.ophisOnly]!.ownFeeBps).toBeNull();
    expect(byUid[uids.ophisOnly]!.ownFeeRecipient).toBeNull();
    expect(byUid[uids.inflated]!.ownFeeBps).toBe(100); // clamped to OWN_FEE_MAX_BPS (100)
    expect(byUid[uids.single]!.ownFeeBps).toBe(30);
    expect(byUid[uids.single]!.ownFeeRecipient).toBe(INTEGRATOR.toLowerCase());
  });
});
