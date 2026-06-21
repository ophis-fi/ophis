/**
 * On-chain settle() decoder: a SUPPLEMENTAL trade source that discovers Ophis
 * settlements straight from the chain (allowlist-free getLogs on the immutable
 * GPv2Settlement Trade event), instead of the owner-scoped CoW orderbook API.
 *
 * Why it exists: the API fetcher finds trades by `owner`, so it MISSES native-ETH
 * (eth-flow, owner = a router contract) and contract-owner / EIP-1271 orders on
 * hosted chains. The decoder sees every settlement and recovers each trade's
 * appData hash from settle() calldata, then attributes it through the SAME
 * `attributeOrder` money-path the API fetcher uses, so guards are identical.
 *
 * Idempotent by construction: rows key on the Trade event's `orderUid` (byte-
 * identical to the API path's trade_uid PK), and upsert only backfills a NULL fee.
 * Safe to run alongside the API fetcher. Scoped per chain via SETTLE_DECODER_CHAINS
 * (default OFF). Base (8453) first; the API fetcher keeps running on all chains.
 */
import { decodeFunctionData, type PublicClient } from 'viem';
import { TRADE_EVENT, SETTLE_FN, GPV2_SETTLEMENT } from './settleAbi.js';
import { getRpcClient } from '../rpc/client.js';
import { orderbookBase } from './client.js';
import { resolveAppData } from './appDataResolver.js';
import { attributeOrder, DECODER_ETHFLOW_OWNERS, type PendingTrade } from '../fetcher.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'settle-decoder' });

// Minimal postgres-js tagged-template shape for the cursor reads/writes.
type SqlTag = <T = Record<string, unknown>>(strings: TemplateStringsArray, ...args: unknown[]) => Promise<T[]>;

export interface SettleDecoderDeps {
  sql: SqlTag;
  upsertTrades: (rows: PendingTrade[]) => Promise<number>;
}

// Decoded GPv2Settlement Trade event log (args fully decoded since `event` is passed).
interface TradeLog {
  args: {
    owner: `0x${string}`;
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmount: bigint;
    buyAmount: bigint;
    feeAmount: bigint;
    orderUid: `0x${string}`;
  };
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

// The GPv2Trade.Data fields the decoder needs from settle() calldata.
interface CalldataTrade {
  sellTokenIndex: bigint;
  buyTokenIndex: bigint;
  receiver: `0x${string}`;
  appData: `0x${string}`;
}

const CONFIRMATIONS = BigInt(process.env.SETTLE_CONFIRMATIONS ?? 8);
const DEFAULT_WINDOW = BigInt(process.env.SETTLE_SCAN_WINDOW ?? 2000);

/**
 * MONEY-PATH SAFETY GATE (ToB review B1/F2). The decoder derives a trade's rebate
 * `volume_fee_bps` from appData the trader fully controls (content-addressed: the
 * re-hash guard proves the doc matches the on-chain hash, but the trader chose
 * both). Until the settlement's ACTUAL ERC-20 fee transfer to the Ophis Safe is
 * verified ON-CHAIN, a self-built "ophis"-tagged Base order could claim an Ophis fee
 * it never paid and farm rebates / dilute the trader pool — and the decoder removes
 * the API fetcher's owner-allowlist containment, widening that surface to every
 * settlement. So the decoder is HARD-disabled here, regardless of
 * SETTLE_DECODER_CHAINS, until that on-chain fee verification lands AND is
 * Codex-reviewed (the money-path rule needs Codex + Trail of Bits; Codex is the
 * second pass). Flip to true ONLY in the PR that adds + reviews fee verification.
 * See ~/ophis-bd/roadmap/DECODER-BUILD-SPEC.md and the ToB report.
 * Exported so a tripwire test fails if it is flipped without the matching review.
 */
export const FEE_VERIFICATION_IMPLEMENTED: boolean = false;

/** Chains the decoder runs on. Empty (the default) = OFF. */
export function settleDecoderChains(): number[] {
  return (process.env.SETTLE_DECODER_CHAINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** A provider "block range too large / too many results" error -> halve + retry. */
export function isRangeError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('-32602') ||
    msg.includes('block range') ||
    msg.includes('range too large') ||
    msg.includes('10000 results') ||
    msg.includes('query returned more than') ||
    msg.includes('response size') ||
    msg.includes('limit exceeded')
  );
}

async function readCursor(chainId: number, sql: SqlTag): Promise<bigint | null> {
  const rows = await sql<{ last_block: string }>`
    SELECT last_block FROM settle_scan_cursor WHERE chain_id = ${chainId}
  `;
  const row = rows[0];
  if (!row) return null;
  return BigInt(row.last_block as unknown as string);
}

async function writeCursor(chainId: number, block: bigint, sql: SqlTag): Promise<void> {
  await sql`
    INSERT INTO settle_scan_cursor (chain_id, last_block, updated_at)
    VALUES (${chainId}, ${block.toString()}, now())
    ON CONFLICT (chain_id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()
  `;
}

/**
 * Decode every Trade event in one block window into attributed PendingTrade rows.
 * Throws on a transient appData-resolver error so the caller does NOT advance the
 * cursor over a window it could not fully resolve (re-scanned next run, idempotent).
 */
export async function decodeWindow(
  chainId: number,
  client: PublicClient,
  logs: TradeLog[],
): Promise<PendingTrade[]> {
  const rows: PendingTrade[] = [];
  const byTx = new Map<`0x${string}`, TradeLog[]>();
  for (const l of logs) {
    const arr = byTx.get(l.transactionHash) ?? [];
    arr.push(l);
    byTx.set(l.transactionHash, arr);
  }
  const blockTs = new Map<bigint, Date>();

  for (const [txHash, txLogs] of byTx) {
    let tokens: readonly `0x${string}`[];
    let trades: readonly CalldataTrade[];
    try {
      const tx = await client.getTransaction({ hash: txHash });
      const decoded = decodeFunctionData({ abi: [SETTLE_FN], data: tx.input });
      if (decoded.functionName !== 'settle') continue;
      const args = decoded.args as unknown as [readonly `0x${string}`[], readonly bigint[], readonly CalldataTrade[], unknown];
      tokens = args[0];
      trades = args[2];
    } catch {
      // Not a direct settle() tx (e.g. settled via a wrapper/router) or fetch failed:
      // skip the whole settlement. Safe (drops, never mis-attributes); coverage note.
      log.debug({ chainId, txHash }, 'settle-decoder: tx not a decodable settle(); skipping');
      continue;
    }

    // Positional join: Nth Trade log (by logIndex) <-> Nth calldata trade.
    const ordered = [...txLogs].sort((a, b) => a.logIndex - b.logIndex);
    for (let i = 0; i < ordered.length; i++) {
      const lg = ordered[i];
      const ct = trades[i];
      if (!lg || !ct) continue; // more Trade logs than calldata trades (unexpected) -> drop, never guess
      const ev = lg.args;

      // ALIGNMENT GUARD: token-index cross-check validates the positional join.
      const sellTok = tokens[Number(ct.sellTokenIndex)];
      const buyTok = tokens[Number(ct.buyTokenIndex)];
      if (
        !sellTok ||
        !buyTok ||
        sellTok.toLowerCase() !== ev.sellToken.toLowerCase() ||
        buyTok.toLowerCase() !== ev.buyToken.toLowerCase()
      ) {
        log.warn({ chainId, txHash, i }, 'settle-decoder: trade alignment mismatch; dropping trade');
        continue; // drop THIS trade only
      }

      const fullAppData = await resolveAppData(chainId, ct.appData);
      if (fullAppData === null) continue; // unpinned / invalid / hash-mismatch -> drop
      let meta: unknown;
      try {
        meta = JSON.parse(fullAppData);
      } catch {
        continue;
      }

      let ts = blockTs.get(lg.blockNumber);
      if (!ts) {
        const block = await client.getBlock({ blockNumber: lg.blockNumber });
        ts = new Date(Number(block.timestamp) * 1000);
        blockTs.set(lg.blockNumber, ts);
      }

      const trade = attributeOrder(
        meta,
        {
          owner: ev.owner,
          receiver: ct.receiver,
          sellToken: ev.sellToken,
          buyToken: ev.buyToken,
          executedSell: ev.sellAmount, // Trade event = actual settled fill (surplus-inclusive)
          executedBuy: ev.buyAmount,
          tradeUid: ev.orderUid,
          chainId,
          blockNumber: lg.blockNumber,
          blockTimestamp: ts,
        },
        DECODER_ETHFLOW_OWNERS, // recognise the shared canonical eth-flow contract too
      );
      if (trade) rows.push(trade);
    }
  }
  return rows;
}

async function scanChain(chainId: number, deps: SettleDecoderDeps): Promise<number> {
  // Misconfiguration guard: the resolver needs a CoW app_data endpoint for this
  // chain. A chain not served by the CoW API (a paused / sovereign-only chain) would
  // otherwise throw on every trade every run; skip it with one clear message.
  try {
    orderbookBase(chainId);
  } catch {
    log.error({ chainId }, 'settle-decoder: chain not served by the CoW app_data API; check SETTLE_DECODER_CHAINS');
    return 0;
  }

  const client = getRpcClient(chainId);
  // Reorg safety (ToB F3): read only up to the FINALIZED head. Base is an OP-stack L2
  // whose UNSAFE head can reorg for minutes, so a small fixed block lag (8 blocks ~16s)
  // is not enough for a money path. Finalized never reorgs, and a daily/monthly rebate
  // cron does not need the tip. Fall back to a confirmation lag only if a provider does
  // not serve the finalized tag.
  let safeHead: bigint;
  try {
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    safeHead = finalized.number ?? 0n;
  } catch {
    safeHead = (await client.getBlockNumber()) - CONFIRMATIONS;
  }
  if (safeHead <= 0n) return 0;

  let cursor = await readCursor(chainId, deps.sql);
  if (cursor === null) {
    const seed = process.env[`SETTLE_SCAN_START_BLOCK_${chainId}`];
    if (!seed) {
      log.warn({ chainId }, 'settle-decoder: no cursor and no SETTLE_SCAN_START_BLOCK; skipping chain');
      return 0;
    }
    cursor = BigInt(seed) - 1n; // so the first scanned block is exactly the seed
  }
  if (cursor >= safeHead) return 0;

  let inserted = 0;
  let window = DEFAULT_WINDOW;
  let from = cursor + 1n;
  while (from <= safeHead) {
    const to = from + window - 1n > safeHead ? safeHead : from + window - 1n;
    let logs: TradeLog[];
    try {
      logs = (await client.getLogs({
        address: GPV2_SETTLEMENT,
        event: TRADE_EVENT,
        fromBlock: from,
        toBlock: to,
      })) as unknown as TradeLog[];
    } catch (err) {
      if (isRangeError(err) && window > 1n) {
        window >>= 1n;
        log.info({ chainId, window: window.toString() }, 'settle-decoder: window too large; halving');
        continue; // retry the SAME `from` with a smaller window
      }
      throw err; // genuine error -> abort chain (cursor not advanced -> re-scanned)
    }
    const rows = await decodeWindow(chainId, client, logs);
    if (rows.length > 0) inserted += await deps.upsertTrades(rows);
    await writeCursor(chainId, to, deps.sql); // advance ONLY after the window's rows upsert
    from = to + 1n;
    if (window < DEFAULT_WINDOW) window = DEFAULT_WINDOW; // restore after a clean window
  }
  return inserted;
}

/**
 * Run the decoder for every configured chain. Called inside runFetcher's advisory
 * lock so cursor bookkeeping + upserts share one critical section. Per-chain errors
 * are logged and isolated (one bad chain never blocks the others).
 */
export async function runSettleDecoder(deps: SettleDecoderDeps): Promise<number> {
  const chains = settleDecoderChains();
  if (chains.length === 0) return 0;
  // B1 money-path safety gate: refuse to write any decoder-discovered trades until
  // on-chain fee verification exists (see FEE_VERIFICATION_IMPLEMENTED). This makes
  // setting SETTLE_DECODER_CHAINS prematurely a no-op rather than a forgery surface.
  if (!FEE_VERIFICATION_IMPLEMENTED) {
    log.error(
      { chains },
      'settle-decoder: HARD-DISABLED pending on-chain fee verification (ToB B1); not writing. See DECODER-BUILD-SPEC.md',
    );
    return 0;
  }
  let inserted = 0;
  for (const chainId of chains) {
    try {
      const n = await scanChain(chainId, deps);
      if (n > 0) log.info({ chainId, inserted: n }, 'settle-decoder: chain scan complete');
      inserted += n;
    } catch (err) {
      log.error({ err, chainId }, 'settle-decoder: chain scan failed');
    }
  }
  return inserted;
}
