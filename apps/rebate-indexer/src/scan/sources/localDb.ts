// src/scan/sources/localDb.ts
import { execFile } from 'node:child_process';
import type { ChainConfig, ScanResult, Swap } from '../types.js';
import { parseAppData } from '../appdata.js';

export type PsqlRunner = (container: string, sql: string) => Promise<string>;

// The orderbook DB stores bytea columns; we hex-encode + prefix 0x in SQL. Join the
// app_data document so we can filter on appCode without a second round-trip, and use
// trades' executed amounts (summed across fills) for true settled volume.
export function buildLocalQuery(t0Iso: string): string {
  return `
    select
      to_char(o.creation_timestamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      '0x'||encode(o.uid,'hex'),
      '0x'||encode(o.owner,'hex'),
      '0x'||encode(o.receiver,'hex'),
      '0x'||encode(o.sell_token,'hex'),
      '0x'||encode(o.buy_token,'hex'),
      sum(t.sell_amount)::text,
      sum(t.buy_amount)::text,
      '0x'||encode(max(s.tx_hash),'hex'),
      convert_from(a.full_app_data,'UTF8')
    from trades t
      join orders o on o.uid = t.order_uid
      join app_data a on a.contract_app_data = o.app_data
      left join settlements s on s.block_number = t.block_number
    where o.creation_timestamp >= '${t0Iso}'::timestamptz
      and convert_from(a.full_app_data,'UTF8')::jsonb->>'appCode' in ('ophis','greg')
    group by o.uid, o.creation_timestamp, o.owner, o.receiver, o.sell_token, o.buy_token, a.full_app_data
    order by o.creation_timestamp desc;`;
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
    const [tsUtc, uid, owner, receiver, sellToken, buyToken, sellAmount, buyAmount, txHash, fullAppData] = line.split('\t');
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
  try {
    const tsv = await run(cfg.dbContainer!, buildLocalQuery(t0Iso));
    const swaps = parseLocalRows(tsv, cfg.chainId, cfg.name);
    return { swaps, coverage: { ...base, fillsScanned: swaps.length, ophisFound: swaps.length } };
  } catch (err) {
    return { swaps: [], coverage: { ...base, status: 'degraded', error: err instanceof Error ? err.message : String(err) } };
  }
}
