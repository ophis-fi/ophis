import type { StatementQuery } from '../business.js';
import { sql } from '../db/index.js';
import { hostedPartnerRecipients, partnerFlow, pendingStatementPayouts } from './report.js';
import { PARTNER_FEE_CHAIN } from './split.js';

export async function getPartnerStatement(wallet: string, q: StatementQuery) {
  const recipient = Buffer.from(wallet.slice(2), 'hex');
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const checked = await tx`SELECT p.chain_id,s.checked_at,s.history_from FROM (${hostedPartnerRecipients()}) p
    LEFT JOIN partner_statement_sync s USING (recipient,chain_id) WHERE p.recipient=${recipient} ORDER BY p.chain_id`;
    const chains = checked.map((row) => Number(row.chain_id));
    const rows = await tx`
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
      FROM partner_statement_receipts r WHERE r.recipient=${recipient} AND (r.source='Ophis' OR r.chain_id=ANY(${chains}::int[]))
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
    const coverage = checked.map((state) => {
      const partial = state.history_from && new Date(state.history_from).getTime() >= Date.parse(q.from);
      return {
        chain: Number(state.chain_id),
        checked: partial || !state.checked_at ? null : new Date(state.checked_at).toISOString(),
      };
    });
    const [pending] = await tx`SELECT 1 FROM (${pendingStatementPayouts()}) p WHERE recipient=${recipient} LIMIT 1`;
    if (pending) {
      const gnosis = coverage.find((c) => c.chain === PARTNER_FEE_CHAIN);
      if (gnosis) gnosis.checked = null;
      else coverage.push({ chain: PARTNER_FEE_CHAIN, checked: null });
    }
    return {
      revision: rows[0]?.revision ?? '0',
      rows: rows.slice(0, 500),
      next: rows.length > 500 ? (rows[499]!.id as string) : null,
      coverage,
    };
  });
}
