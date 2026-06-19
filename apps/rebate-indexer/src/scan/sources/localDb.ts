// src/scan/sources/localDb.ts
import { execFile } from 'node:child_process';
import type { ChainConfig, ScanResult, Swap } from '../types.js';
import { parseAppData } from '../appdata.js';
import { redactSecrets } from '../redact.js';

export type PsqlRunner = (container: string, sql: string) => Promise<string>;

// The orderbook DB stores bytea columns; we hex-encode + prefix 0x in SQL. Join the
// app_data document so we can filter on appCode without a second round-trip, and use
// trades' executed amounts (summed across fills) for true settled volume.
//
// Trade -> settlement mapping (CoW orderbook schema): BOTH `trades` and
// `settlements` are keyed by (block_number, log_index) and are reorg-safe event
// rows. Within a settlement transaction the Settlement event is emitted AFTER its
// Trade events, so a trade's settlement is the FIRST settlement in the SAME block
// whose log_index is greater than the trade's. We map each trade to exactly that
// one settlement via a LATERAL sub-select (this mirrors the upstream
// crates/database/src/trades.rs SETTLEMENT_JOIN). The old
// `left join settlements on s.block_number = t.block_number` fanned every trade
// across every settlement in the block, multiplying sum(sell_amount)/sum(buy_amount)
// by the settlement count and letting max(tx_hash) point at an unrelated settlement.
//
// Window: we filter on the SETTLEMENT time, not order creation. A limit/TWAP order
// created before --since but settled inside the window must be counted. The
// settlement timestamp comes from settlement_executions (joined by the settlement's
// auction_id+solver); when it is unavailable we conservatively fall back to the
// order's creation_timestamp (these are market orders that settle near-instantly,
// so creation ~ settlement). Receiver: orders.receiver is NULL when the owner
// receives the buy tokens, so we COALESCE to o.owner (the hosted path's
// actual-recipient fallback).
export function buildLocalQuery(t0Iso: string): string {
  return `
    select
      to_char(max(coalesce(stl.settled_at, o.creation_timestamp)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      '0x'||encode(o.uid,'hex'),
      '0x'||encode(o.owner,'hex'),
      '0x'||encode(coalesce(o.receiver, o.owner),'hex'),
      '0x'||encode(o.sell_token,'hex'),
      '0x'||encode(o.buy_token,'hex'),
      sum(t.sell_amount)::text,
      sum(t.buy_amount)::text,
      '0x'||max(stl.tx_hash_hex),
      convert_from(a.full_app_data,'UTF8')
    from trades t
      join orders o on o.uid = t.order_uid
      join app_data a on a.contract_app_data = o.app_data
      left join lateral (
        select encode(s.tx_hash,'hex') as tx_hash_hex, se.start_timestamp as settled_at
        from settlements s
        left join settlement_executions se on se.auction_id = s.auction_id and se.solver = s.solver
        where s.block_number = t.block_number and s.log_index > t.log_index
        order by s.log_index asc
        limit 1
      ) stl on true
    where coalesce(stl.settled_at, o.creation_timestamp) >= '${t0Iso}'::timestamptz
      and lower(convert_from(a.full_app_data,'UTF8')::jsonb->>'appCode') in ('ophis','greg')
    group by o.uid, o.creation_timestamp, o.owner, o.receiver, o.sell_token, o.buy_token, a.full_app_data
    order by max(coalesce(stl.settled_at, o.creation_timestamp)) desc;`;
}

export const dockerPsql: PsqlRunner = (container, sql) =>
  new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'psql', '-U', 'ophis', '-d', 'ophis', '-F', '\t', '-A', '-t', '-c', sql],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });

export function parseLocalRows(tsv: string, chainId: number, chainName: string): Swap[] {
  const out: Swap[] = [];
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 10) continue; // malformed row; valid SQL output always has all 10 columns
    const [tsUtc, uid, owner, receiver, sellToken, buyToken, sellAmount, buyAmount, txHash, fullAppData] = fields;
    const info = parseAppData(fullAppData);
    if (!info.appCode) continue; // defensive; the SQL already filtered
    out.push({
      chainId, chainName, tsUtc: tsUtc!,
      orderUid: uid as `0x${string}`,
      txHash: (txHash && txHash !== '0x') ? (txHash as `0x${string}`) : null,
      owner: owner as `0x${string}`,
      receiver: receiver as `0x${string}`,
      sell: { token: sellToken as `0x${string}`, symbol: null, decimals: null, amount: sellAmount! },
      buy: { token: buyToken as `0x${string}`, symbol: null, decimals: null, amount: buyAmount! },
      appCode: info.appCode, refCode: info.refCode, feeBps: info.feeBps, notionalUsd: null,
    });
  }
  return out;
}

export async function scanLocalDbChain(cfg: ChainConfig, t0Iso: string, run: PsqlRunner = dockerPsql): Promise<ScanResult> {
  const base: ScanResult['coverage'] = { chainId: cfg.chainId, chainName: cfg.name, status: 'ok', fillsScanned: 0, ophisFound: 0, unresolved: 0 };
  if (!cfg.dbContainer) {
    return { swaps: [], coverage: { ...base, status: 'degraded', error: 'dbContainer not configured' } };
  }
  try {
    const tsv = await run(cfg.dbContainer, buildLocalQuery(t0Iso));
    const swaps = parseLocalRows(tsv, cfg.chainId, cfg.name);
    return { swaps, coverage: { ...base, fillsScanned: swaps.length, ophisFound: swaps.length } };
  } catch (err) {
    return { swaps: [], coverage: { ...base, status: 'degraded', error: redactSecrets(err instanceof Error ? err.message : String(err)) } };
  }
}
