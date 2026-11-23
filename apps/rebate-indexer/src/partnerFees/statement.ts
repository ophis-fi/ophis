import type { StatementQuery } from '../business.js';
import { sql } from '../db/index.js';
import { hostedChains, partnerFlow } from './report.js';
import { payoutChains } from './statementSync.js';

export async function getPartnerStatement(wallet: string, q: StatementQuery) {
  const recipient = Buffer.from(wallet.slice(2), 'hex');
  const rows = await sql`
    WITH flow AS (${partnerFlow(recipient)}), ledger AS (
      SELECT concat('f:',p.chain_id,':',p.block_number,':',p.log_index,':',encode(p.trade_uid,'hex')) AS id,
        'Trade' AS kind,p.source,p.chain_id AS chain,p.block_timestamp AS at,p.transaction_hash AS tx,p.trade_uid AS uid,
        p.block_number AS block,p.log_index AS log,p.value_usd AS volume,p.volume_bps AS bps,
        '0x'||encode(COALESCE(p.fee_token,a.token),'hex') AS asset,COALESCE(p.fee_amount,a.atoms) AS atoms,m.decimals,m.symbol,
        CASE WHEN p.fee_amount IS NOT NULL OR a.atoms IS NOT NULL THEN 'Assessed' ELSE 'Estimated' END AS status,
        CASE WHEN p.fee_amount IS NOT NULL THEN p.fee_usd
          WHEN a.atoms=0 THEN 0
          WHEN a.token=p.sell_token THEN p.value_usd*a.atoms/NULLIF(p.sell_amount,0)
          WHEN a.token=p.buy_token THEN p.value_usd*a.atoms/NULLIF(p.buy_amount,0)
          WHEN a.atoms IS NULL THEN p.value_usd*p.volume_bps/10000 END AS usd
      FROM flow p LEFT JOIN partner_statement_assessments a ON p.source='CoW' AND a.recipient=${recipient}
        AND (a.chain_id,a.block_number,a.log_index,a.trade_uid)=(p.chain_id,p.block_number,p.log_index,p.trade_uid)
      LEFT JOIN partner_statement_tokens m ON m.chain_id=p.chain_id AND m.token=COALESCE(p.fee_token,a.token)
      UNION ALL
      SELECT concat('p:',r.source,':',r.chain_id,':',encode(convert_to(r.transfer_id,'UTF8'),'hex')),
        'Payout',r.source,r.chain_id,r.paid_at,r.tx,NULL,NULL,NULL,NULL,NULL,r.asset,r.atoms,18,r.asset,'Received',r.usd
      FROM partner_statement_receipts r WHERE r.recipient=${recipient}
    ), dated AS (
      SELECT ledger.*,sum(hashtextextended(ledger::text,0)::numeric) OVER ()::text AS revision
      FROM ledger WHERE at >= (${q.from}::date::timestamp AT TIME ZONE 'UTC')
        AND at < ((${q.to}::date+1)::timestamp AT TIME ZONE 'UTC')
    )
    SELECT revision,id,kind,source,chain,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      '0x'||encode(tx,'hex') AS tx,'0x'||encode(uid,'hex') AS uid,block::text,log::integer AS log,volume::text,bps,asset,atoms::text,decimals,symbol,status,
      round(usd,12)::text AS usd
    FROM dated WHERE id COLLATE "C" > ${q.after ?? ''}
    ORDER BY id COLLATE "C" LIMIT 501`;
  const checked =
    await sql`SELECT chain_id,checked_at,history_from FROM partner_statement_sync WHERE recipient=${recipient} ORDER BY chain_id`;
  const hosted =
    await sql`SELECT DISTINCT chain_id FROM trades WHERE own_fee_recipient=${recipient} AND fee_verified AND own_fee_bps>0
    AND chain_id=ANY(${hostedChains}::int[])`;
  const chains = hosted.length
    ? [...new Set([...Object.keys(payoutChains).map(Number), ...hosted.map((r) => Number(r.chain_id))])].sort(
        (a, b) => a - b,
      )
    : [];
  const coverage = chains.map((chain) => {
    const state = checked.find((r) => r.chain_id === chain);
    const partial = state?.history_from && new Date(state.history_from).getTime() >= Date.parse(q.from);
    return { chain, checked: partial || !state?.checked_at ? null : new Date(state.checked_at).toISOString() };
  });
  return {
    revision: rows[0]?.revision ?? '0',
    rows: rows.slice(0, 500),
    next: rows.length > 500 ? (rows[499]!.id as string) : null,
    coverage,
  };
}
