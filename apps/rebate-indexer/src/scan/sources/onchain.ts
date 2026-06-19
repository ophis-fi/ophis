// src/scan/sources/onchain.ts
import { parseAbiItem } from 'viem';
import type { CowOrder } from '../../cow/types.js';
import type { ChainConfig, ScanCache, ScanResult, Swap } from '../types.js';
import { parseAppData } from '../appdata.js';
import { redactSecrets } from '../redact.js';
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
  blockNumber: bigint; // settlement block of (the first observed fill of) this order
}

// One order can settle across MULTIPLE Trade fills (partial-fill / TWAP). We
// AGGREGATE the fills per uid, summing the fetched fill amounts. The fetched logs
// are already window-bounded (collectTradeLogs fetches from the t0 block), so the
// sum is the true IN-WINDOW settled volume, NOT the order's lifetime executed total
// (which would also count pre-window fills and over-pay a window-straddling TWAP
// order). txHash / settlement block anchor to the first observed fill.
export function fillsFromLogs(logs: DecodedTradeLog[]): RawFill[] {
  const byUid = new Map<string, RawFill>();
  for (const l of logs) {
    const uid = l.args.orderUid.toLowerCase();
    const existing = byUid.get(uid);
    if (existing === undefined) {
      byUid.set(uid, {
        orderUid: l.args.orderUid,
        owner: l.args.owner,
        sellToken: l.args.sellToken,
        buyToken: l.args.buyToken,
        sellAmount: l.args.sellAmount,
        buyAmount: l.args.buyAmount,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      });
    } else {
      existing.sellAmount += l.args.sellAmount;
      existing.buyAmount += l.args.buyAmount;
    }
  }
  return [...byUid.values()];
}

export interface ClassifyDeps {
  getOrder(chainId: number, uid: `0x${string}`): Promise<CowOrder>;
  cache: ScanCache;
  // Resolves a settlement block number to its unix-seconds timestamp so the
  // window check uses SETTLEMENT time, not order creation time.
  getBlockTimestamp(blockNumber: bigint): Promise<number>;
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
    // Negative cache: a uid we already resolved to a non-Ophis appCode is skipped
    // cheaply. (We ONLY cache 'none' when appData parsed to a real non-Ophis
    // appCode below, so an unresolved/unparsable order is never poisoned here.)
    if (deps.cache.get(f.orderUid) === 'none') continue;

    let order: CowOrder;
    try {
      order = await deps.getOrder(chainId, f.orderUid);
    } catch {
      unresolved += 1; // order aged out of CoW's DB, or transient failure
      continue;
    }

    // Distinguish "appData resolved to non-Ophis" from "appData not resolvable yet".
    // Only the former is a stable fact safe to negative-cache; the latter must be
    // retried on a future scan (CoW may resolve fullAppData later), so we count it
    // as unresolved and do NOT poison the cache.
    if (order.fullAppData == null) {
      unresolved += 1;
      continue;
    }
    const info = parseAppData(order.fullAppData);
    if (!info.appCode) {
      // fullAppData was present but yielded no Ophis appCode. If it was genuinely
      // unparsable (not an object / bad JSON) treat as unresolved and retry; only
      // a SUCCESSFULLY parsed non-Ophis document is negative-cached.
      if (isParseableAppData(order.fullAppData)) deps.cache.set(f.orderUid, 'none');
      else unresolved += 1;
      continue;
    }
    deps.cache.set(f.orderUid, info.appCode);

    // Window-filter by SETTLEMENT time (the fill's block timestamp), NOT the order's
    // creationDate: a limit/TWAP order created before t0 but settled in-window must
    // be counted.
    let settledSec: number;
    try {
      settledSec = await deps.getBlockTimestamp(f.blockNumber);
    } catch {
      unresolved += 1; // could not resolve settlement time; retry next scan
      continue;
    }
    if (!Number.isFinite(settledSec) || settledSec < t0Sec) continue;
    const tsUtc = new Date(settledSec * 1000).toISOString();

    // Volume = the SUM of the IN-WINDOW Trade fills for this order (aggregated in
    // fillsFromLogs), NOT the order's lifetime executedSellAmount: the latter also
    // counts pre-window fills and would over-pay a window-straddling TWAP order.
    // This matches the local-DB path, which sums only in-window trades.
    const sellAmount = f.sellAmount.toString();
    const buyAmount = f.buyAmount.toString();

    swaps.push({
      chainId,
      chainName,
      tsUtc,
      orderUid: f.orderUid,
      txHash: f.txHash,
      owner: f.owner,
      receiver: (order.receiver ?? f.owner) as `0x${string}`,
      sell: { token: f.sellToken, symbol: null, decimals: null, amount: sellAmount },
      buy: { token: f.buyToken, symbol: null, decimals: null, amount: buyAmount },
      appCode: info.appCode,
      refCode: info.refCode,
      feeBps: info.feeBps,
      notionalUsd: null,
    });
  }

  return { swaps, ophisFound: swaps.length, unresolved };
}

// True iff `fullAppData` parses to a JSON object (the shape parseAppData inspects).
// Used to decide whether a non-Ophis result is a STABLE fact (object, but not an
// Ophis appCode -> safe to negative-cache) versus UNRESOLVED (null / bad JSON /
// non-object -> retry on a future scan).
function isParseableAppData(fullAppData: string): boolean {
  try {
    const parsed = JSON.parse(fullAppData);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
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

// Caches block->timestamp lookups so window-filtering a settlement block costs at
// most one getBlock per distinct block within a scan.
export function makeBlockTimestampResolver(client: BlockClient): (blockNumber: bigint) => Promise<number> {
  const cache = new Map<string, number>();
  return async (blockNumber: bigint): Promise<number> => {
    const key = blockNumber.toString();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const { timestamp } = await client.getBlock({ blockNumber });
    const sec = Number(timestamp);
    cache.set(key, sec);
    return sec;
  };
}

export async function scanHostedChain(
  cfg: ChainConfig,
  t0Sec: number,
  deps: { client: LogClient } & Omit<ClassifyDeps, 'getBlockTimestamp'>,
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
    const getBlockTimestamp = makeBlockTimestampResolver(deps.client);
    const { swaps, ophisFound, unresolved } = await classifyFills(
      cfg.chainId, cfg.name, fills, t0Sec, { ...deps, getBlockTimestamp },
    );
    return { swaps, coverage: { ...base, fillsScanned: fills.length, ophisFound, unresolved } };
  } catch (err) {
    // redact: viem RPC errors echo the URL, which embeds the Alchemy key in its path.
    return { swaps: [], coverage: { ...base, status: 'degraded', error: redactSecrets(err instanceof Error ? err.message : String(err)) } };
  }
}
