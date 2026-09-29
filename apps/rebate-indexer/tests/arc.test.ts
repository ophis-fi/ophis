import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orderbookBase, SUPPORTED_CHAIN_IDS } from '../src/cow/client.js';
import { fetchChainTrades, readAssessedOphisFeeBps, type PendingDefiLlamaFill } from '../src/fetcher.js';
import { CowTrade } from '../src/cow/types.js';
import { priceTrade, priceDefiLlamaFill } from '../src/pricer.js';
import { keepFractionBps, OWN_FEE_GUARANTEED_CHAIN_IDS } from '../src/affiliate/rates.js';
import { PRODUCTION_CHAIN_IDS, renderStatsPage } from '../src/stats-page.js';
import { getRpcClient } from '../src/rpc/client.js';
import { SCAN_CHAINS } from '../src/scan/chains.js';
import { scanLocalDbChain } from '../src/scan/sources/localDb.js';
import { tokenMeta } from '../src/scan/enrich.js';

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const uid = `0x${'ab'.repeat(56)}` as const;
const owner = `0x${'cd'.repeat(20)}` as const;
const meta = { appCode: 'ophis', metadata: { partnerFee: {
  recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8', volumeBps: 1,
} } };
// Actual executed amounts from Arc block 23218655 (10 USDC -> EURC).
const trade = CowTrade.parse({
  blockNumber: 23218655, logIndex: 82, orderUid: uid, owner,
  sellToken: USDC, buyToken: EURC, sellAmount: '10000000',
  sellAmountBeforeFees: '10000000', buyAmount: '8746671',
  txHash: `0x${'ef'.repeat(32)}`,
  executedProtocolFees: [{ policy: { volume: { factor: 0.0001 } }, amount: '874', token: EURC }],
});
afterEach(() => vi.unstubAllGlobals());

it('requires explicit Arc bootstrap and does not activate genesis archive audits on the free RPC', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  expect(compose).toContain('SETTLE_DECODER_CHAINS: ${SETTLE_DECODER_CHAINS-10,130}');
  expect(compose).not.toContain('SETTLE_SCAN_START_BLOCK_5042:');
});

it('covers Arc across ingestion, reporting, RPC and fee accounting without enabling payouts', () => {
  expect(SUPPORTED_CHAIN_IDS).toContain(5042);
  expect(PRODUCTION_CHAIN_IDS).toContain(5042);
  expect(orderbookBase(5042)).toBe('https://arc-mainnet.ophis.fi');
  expect(() => getRpcClient(5042)).not.toThrow();
  expect(keepFractionBps(5042)).toBe(10000);
  expect(OWN_FEE_GUARANTEED_CHAIN_IDS.has(5042)).toBe(false);
});

it('ingests a settled Arc trade and its fee-bearing fill via the existing owner API', async () => {
  const getSettlementTimestamp = vi.fn(async () => new Date('2026-09-28T15:19:00Z'));
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/api/v2/trades?')) return Response.json([trade]);
    if (String(url).endsWith(`/api/v1/orders/${uid}`)) return Response.json({
      ...trade, uid, class: 'limit', status: 'fulfilled', appData: '0xabc',
      fullAppData: JSON.stringify(meta), creationDate: '2026-09-28T15:18:38Z',
      executedSellAmount: trade.sellAmount, executedBuyAmount: trade.buyAmount,
    });
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const fills: PendingDefiLlamaFill[] = [];
  const rows = await fetchChainTrades(5042, owner, { defillamaFills: fills, getSettlementTimestamp });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ chainId: 5042, wallet: owner, sellAmount: 10000000n, feeVerified: true, volumeFeeBps: 1 });
  expect(fills).toHaveLength(1);
  expect(fills[0]).toMatchObject({ chainId: 5042, blockNumber: 23218655n, logIndex: 82, feeVerified: true });
  expect(Number(fills[0]!.assessedFeeBps)).toBeCloseTo(874 / (8746671 + 874) * 10000, 8);
  expect(getSettlementTimestamp).toHaveBeenCalledWith(5042, 23218655n);
  expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(orderbookBase(5042)))).toBe(true);
});

it('matches Arc partner-only fees for market and limit orders, rejecting unknown prefixes and mismatches', () => {
  for (const cls of ['market', 'limit'] as const) {
    expect(Number(readAssessedOphisFeeBps(5042, cls, meta, trade))).toBeCloseTo(0.99913747, 8);
  }
  const extra = { ...trade, executedProtocolFees: [
    { policy: { priceImprovement: { factor: 0.8, maxVolumeFactor: 0.0099 } }, amount: '123', token: EURC },
    ...trade.executedProtocolFees!,
  ] };
  expect(readAssessedOphisFeeBps(5042, 'market', meta, extra)).toBeNull();
  expect(readAssessedOphisFeeBps(5042, undefined, meta, trade)).toBeNull();
  expect(readAssessedOphisFeeBps(5042, 'limit', { metadata: { partnerFee: { ...meta.metadata.partnerFee, volumeBps: 10 } } }, trade)).toBeNull();
});

it('prices ERC-20 USDC at 6 decimals and cancels native wei units for EURC', async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => Response.json({
    price: String(url).includes(EURC) ? 1.1363450180456391e12 : 1e12,
  }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await priceTrade({ tradeUid: uid, chainId: 5042, sellToken: USDC, sellAmount: 10000000n })).toBe(10);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await priceTrade({ tradeUid: uid, chainId: 5042, sellToken: EURC, sellAmount: 10487578n })).toBeCloseTo(11.91750701, 7);
  expect(await tokenMeta(USDC, null, new Map())).toEqual({ symbol: 'USDC', decimals: 6 });
});

it('reports proven fee-free Arc fills as zero, not missing or unexplained executions', () => {
  const noFeeMeta = { appCode: 'ophis' };
  expect(readAssessedOphisFeeBps(5042, 'limit', noFeeMeta, { ...trade, executedProtocolFees: [] })).toBe('0.00000000');
  expect(readAssessedOphisFeeBps(5042, 'limit', noFeeMeta, { ...trade, executedProtocolFees: undefined })).toBeNull();
  expect(readAssessedOphisFeeBps(5042, 'limit', noFeeMeta, trade)).toBeNull();
  expect(readAssessedOphisFeeBps(10, 'limit', noFeeMeta, { ...trade, executedProtocolFees: [] })).toBeNull();
  const partnerOnly = { metadata: { partnerFee: { ...meta.metadata.partnerFee, recipient: owner } } };
  expect(readAssessedOphisFeeBps(5042, 'limit', partnerOnly, trade)).toBe('0.00000000');
});

it('uses Arc historical prices for a non-USDC fill, rejecting stale historical quotes', async () => {
  const timestamp = 1790608800;
  const fetchMock = vi.fn(async () => Response.json({ coins: {
    [`arc:${EURC}`]: { decimals: 6, price: 1.1363450180456391, timestamp },
  } }));
  vi.stubGlobal('fetch', fetchMock);
  const fill = { chainId: 5042, sellToken: EURC, sellAmount: 10487578n, settlementTimestamp: new Date(timestamp * 1000) } as const;
  expect(await priceDefiLlamaFill(fill)).toBeCloseTo(11.91750701, 7);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/historical/${timestamp}/arc:${EURC}`), expect.anything());
  await expect(priceDefiLlamaFill({ ...fill, settlementTimestamp: new Date((timestamp + 14401) * 1000) })).rejects.toThrow('invalid DefiLlama historical price');
});

it('uses the existing local-DB scanner for full Arc history without RPC log sweeps', async () => {
  const cfg = SCAN_CHAINS.find(c => c.chainId === 5042)!;
  const run = vi.fn(async () => '');
  expect((await scanLocalDbChain(cfg, '2026-09-24T00:00:00Z', run)).coverage.status).toBe('ok');
  expect(run).toHaveBeenCalledWith('ophis-arc-postgres-1', expect.any(String), 'arc');
});

it('renders the real Arc row and chain filter with its icon', () => {
  const html = renderStatsPage({ totalVolumeUsd: 10, totalTrades: 1, distinctTraders: 1, chainsActive: 1,
    byChain: [{ chainId: 5042, volumeUsd: 10, trades: 1 }], generatedAt: '', dataAsOf: null,
    dataFresh: false, dataStatus: 'degraded', dataStaleReason: 'never_refreshed',
  }, new URLSearchParams('chain=5042'));
  expect(html).toContain('/chain-icons/5042');
  expect(html).toContain('<option value="5042" selected>Arc</option>');
  expect(html).not.toContain('Arc activity is not yet included');
});
