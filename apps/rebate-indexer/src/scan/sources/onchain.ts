// src/scan/sources/onchain.ts
import { parseAbiItem } from 'viem';
import type { CowOrder } from '../../cow/types.js';
import type { ChainConfig, ScanCache, ScanResult, Swap } from '../types.js';
import { parseAppData } from '../appdata.js';
import { blockAtTimestamp, type BlockClient } from '../window.js';

export const SETTLEMENT_ADDRESS = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;
export const TRADE_EVENT = parseAbiItem(
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
);

export interface DecodedTradeLog {
  args: {
    owner: `0x${string}`;
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmount: bigint;
    buyAmount: bigint;
    orderUid: `0x${string}`;
  };
  transactionHash: `0x${string}` | null;
  blockNumber: bigint;
}

export interface RawFill {
  orderUid: `0x${string}`;
  owner: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  txHash: `0x${string}` | null;
}

// One order can settle across multiple fills (same orderUid). Keep the first.
export function fillsFromLogs(logs: DecodedTradeLog[]): RawFill[] {
  const seen = new Set<string>();
  const out: RawFill[] = [];
  for (const l of logs) {
    const uid = l.args.orderUid.toLowerCase();
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      orderUid: l.args.orderUid,
      owner: l.args.owner,
      sellToken: l.args.sellToken,
      buyToken: l.args.buyToken,
      sellAmount: l.args.sellAmount,
      buyAmount: l.args.buyAmount,
      txHash: l.transactionHash,
    });
  }
  return out;
}

export interface ClassifyDeps {
  getOrder(chainId: number, uid: `0x${string}`): Promise<CowOrder>;
  cache: ScanCache;
}

export async function classifyFills(
  chainId: number,
  chainName: string,
  fills: RawFill[],
  t0Sec: number,
  deps: ClassifyDeps,
): Promise<{ swaps: Swap[]; ophisFound: number; unresolved: number }> {
  const swaps: Swap[] = [];
  let unresolved = 0;

  for (const f of fills) {
    // Negative cache: a uid we already resolved to non-Ophis is skipped cheaply.
    if (deps.cache.get(f.orderUid) === 'none') continue;

    let order: CowOrder;
    try {
      order = await deps.getOrder(chainId, f.orderUid);
    } catch {
      unresolved += 1; // order aged out of CoW's DB, or transient failure
      continue;
    }

    const info = parseAppData(order.fullAppData);
    if (!info.appCode) {
      deps.cache.set(f.orderUid, 'none');
      continue;
    }
    deps.cache.set(f.orderUid, info.appCode);

    // Window-filter by the order's creationDate (settlement is near-instant).
    const tsSec = Math.floor(new Date(order.creationDate).getTime() / 1000);
    if (!Number.isFinite(tsSec) || tsSec < t0Sec) continue;

    swaps.push({
      chainId,
      chainName,
      tsUtc: order.creationDate,
      orderUid: f.orderUid,
      txHash: f.txHash,
      owner: f.owner,
      receiver: (order.receiver ?? f.owner) as `0x${string}`,
      sell: { token: f.sellToken, symbol: null, decimals: null, amount: f.sellAmount.toString() },
      buy: { token: f.buyToken, symbol: null, decimals: null, amount: f.buyAmount.toString() },
      appCode: info.appCode,
      refCode: info.refCode,
      feeBps: info.feeBps,
      notionalUsd: null,
    });
  }

  return { swaps, ophisFound: swaps.length, unresolved };
}

// ---------------------------------------------------------------------------
// Live chain driver: chunked getLogs + per-chain isolated scan.
// ---------------------------------------------------------------------------

export interface LogClient extends BlockClient {
  getLogs(a: {
    address: `0x${string}`;
    event: typeof TRADE_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<DecodedTradeLog[]>;
}

const DEFAULT_CHUNK = 2_000n;
const MIN_CHUNK = 100n;

export async function collectTradeLogs(
  client: LogClient,
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint = DEFAULT_CHUNK,
): Promise<DecodedTradeLog[]> {
  const out: DecodedTradeLog[] = [];
  let start = fromBlock;
  let size = chunk;
  while (start <= toBlock) {
    const end = start + size - 1n > toBlock ? toBlock : start + size - 1n;
    try {
      const logs = await client.getLogs({ address: SETTLEMENT_ADDRESS, event: TRADE_EVENT, fromBlock: start, toBlock: end });
      out.push(...logs);
      start = end + 1n;
      if (size < chunk) size = chunk; // recover chunk size after a successful smaller window
    } catch (err) {
      if (size <= MIN_CHUNK) throw err; // genuinely failing, not a range/size limit
      size = size / 2n > MIN_CHUNK ? size / 2n : MIN_CHUNK;
    }
  }
  return out;
}

export async function scanHostedChain(
  cfg: ChainConfig,
  t0Sec: number,
  deps: { client: LogClient } & ClassifyDeps,
): Promise<ScanResult> {
  const base: ScanResult['coverage'] = {
    chainId: cfg.chainId, chainName: cfg.name, status: 'ok', fillsScanned: 0, ophisFound: 0, unresolved: 0,
  };
  try {
    const fromBlock = await blockAtTimestamp(deps.client, t0Sec);
    const head = await deps.client.getBlockNumber();
    if (fromBlock > head) return { swaps: [], coverage: base };
    const logs = await collectTradeLogs(deps.client, fromBlock, head);
    const fills = fillsFromLogs(logs);
    const { swaps, ophisFound, unresolved } = await classifyFills(cfg.chainId, cfg.name, fills, t0Sec, deps);
    return { swaps, coverage: { ...base, fillsScanned: fills.length, ophisFound, unresolved } };
  } catch (err) {
    return { swaps: [], coverage: { ...base, status: 'degraded', error: err instanceof Error ? err.message : String(err) } };
  }
}
