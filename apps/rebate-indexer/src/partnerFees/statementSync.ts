import { ethAddress, erc20Abi, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { getMultiSendDeployments, getMultiSendCallOnlyDeployments } from '@safe-global/safe-deployments';
import { decodeMultiSendCalldata, encodeMultiSend, encodeMultiSendCalldata } from '../batch/multisend.js';
import { z } from 'zod';
import { getOrder, listTrades } from '../cow/client.js';
import { resolveAppData } from '../cow/appDataResolver.js';
import { sql } from '../db/index.js';
import { executedRecipientFees } from '../fetcher.js';
import { logger } from '../logger.js';
import { priceDefiLlamaFill } from '../pricer.js';
import { getRpcClient } from '../rpc/client.js';
import { WETH_GNOSIS, WXDAI_GNOSIS } from '../safe/addresses.js';
import { hostedChains } from './report.js';
import { PARTNER_FEE_CHAIN } from './split.js';

// CoW's accounting registry: github.com/cowprotocol/dune-queries/blob/main/cowprotocol/lookup_tables/payout_safe_addresses_5454283.sql
const mainSafe = '0xA03be496e67Ec29bC62F01a428683D7F9c204930';
const arbSafe = '0x66331f0b9cb30d38779c786Bda5a3d57d12fbA50';
export const payoutChains: Record<number, { slug: string; safe: string; symbol: string; wrapper: Hex }> = {
  1: { slug: 'eth', safe: mainSafe, symbol: 'ETH', wrapper: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  100: { slug: 'gno', safe: mainSafe, symbol: 'xDAI', wrapper: WXDAI_GNOSIS },
  56: { slug: 'bnb', safe: mainSafe, symbol: 'BNB', wrapper: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },
  137: { slug: 'pol', safe: arbSafe, symbol: 'POL', wrapper: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },
  8453: { slug: 'base', safe: mainSafe, symbol: 'ETH', wrapper: '0x4200000000000000000000000000000000000006' },
  42161: { slug: 'arb1', safe: arbSafe, symbol: 'ETH', wrapper: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  43114: { slug: 'avax', safe: mainSafe, symbol: 'AVAX', wrapper: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' },
};

const buf = (hex: string) => Buffer.from(hex.slice(2), 'hex');
const hex = (bytes: Buffer): Hex => `0x${bytes.toString('hex')}`;
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const safeTx = z.object({
  safe: address,
  to: address,
  value: z.string().regex(/^\d+$/),
  operation: z.number().int(),
  nonce: z.number().int().nonnegative(),
  isExecuted: z.literal(true),
  isSuccessful: z.boolean().nullable(),
  data: z
    .string()
    .regex(/^0x(?:[0-9a-f]{2})*$/i)
    .nullable(),
  executionDate: z.iso.datetime(),
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
});
const page = z.object({ next: z.string().nullable(), results: z.array(safeTx).max(50) });

function multisends(chain: number) {
  const network = String(chain);
  const addresses = new Set<string>();
  for (const version of ['1.1.1', '1.3.0', '1.4.1', '1.5.0']) {
    for (const get of [getMultiSendDeployments, getMultiSendCallOnlyDeployments]) {
      const found = get({ version, network })?.networkAddresses[network] ?? [];
      for (const addr of [found].flat()) addresses.add(addr.toLowerCase());
    }
  }
  return addresses;
}

export function nativeDistributions(tx: z.infer<typeof safeTx>, recipient: string, trusted: Set<string>) {
  if (tx.isSuccessful === false) return [];
  const to = tx.to.toLowerCase() as Hex;
  const data = (tx.data ?? '0x').toLowerCase() as Hex;
  const direct = tx.operation === 0 && to === recipient && data === '0x';
  const batch = tx.operation === 1 && trusted.has(to) && data.startsWith('0x8d80ff0a');
  if (!direct && (!batch || !data.includes(recipient.slice(2)))) return [];
  const calls: ReturnType<typeof decodeMultiSendCalldata> = direct
    ? [{ to, value: BigInt(tx.value), data }]
    : decodeMultiSendCalldata(data);
  const matched = calls.flatMap((c, i) =>
    c.to.toLowerCase() === recipient && c.data === '0x' && c.value > 0n ? [{ i, atoms: c.value }] : [],
  );
  // The shared queue decoder keeps partial frames and discards the operation byte. Require a full all-CALL round trip for a payment.
  if (
    matched.length &&
    (tx.isSuccessful !== true || (!direct && encodeMultiSendCalldata(encodeMultiSend(calls)).toLowerCase() !== data))
  ) {
    throw new Error('Unverified payout batch');
  }
  return matched;
}

async function syncReceipts(recipient: Buffer, chain: number, startNonce: number) {
  const { slug, safe, symbol } = payoutChains[chain]!;
  const wallet = hex(recipient);
  const trusted = multisends(chain);
  const url = new URL(`https://api.safe.global/tx-service/${slug}/api/v1/safes/${safe}/multisig-transactions/`);
  url.search = new URLSearchParams({ executed: 'true', ordering: 'nonce', limit: '50' }).toString();
  let nonce = startNonce;
  for (;;) {
    url.searchParams.set('nonce__gte', String(nonce));
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Safe transaction service ${res.status}`);
    const data = page.parse(await res.json());
    if (data.next && !data.results.length) throw new Error('Incomplete Safe history');
    let latestGap: string | null = null;
    await sql.begin(async (tx) => {
      for (const t of data.results) {
        if (t.safe.toLowerCase() !== safe.toLowerCase() || t.nonce < nonce) throw new Error('Unordered Safe history');
        if (t.nonce > nonce) latestGap = t.executionDate;
        nonce = t.nonce + 1;
        for (const payment of nativeDistributions(t, wallet, trusted)) {
          await tx`INSERT INTO partner_statement_receipts (recipient,chain_id,source,transfer_id,tx,paid_at,asset,atoms)
            VALUES (${recipient},${chain},'CoW',${t.nonce + '-' + payment.i},${buf(t.transactionHash)},${t.executionDate},${symbol},${payment.atoms.toString()})
            ON CONFLICT DO NOTHING`;
        }
      }
      await tx`INSERT INTO partner_statement_sync (recipient,chain_id,next_nonce,checked_at,history_from)
        VALUES (${recipient},${chain},${nonce},CASE WHEN ${!data.next} THEN now() END,${latestGap})
        ON CONFLICT (recipient,chain_id) DO UPDATE SET next_nonce=GREATEST(partner_statement_sync.next_nonce,excluded.next_nonce),
          history_from=GREATEST(excluded.history_from,partner_statement_sync.history_from),
          checked_at=COALESCE(excluded.checked_at,partner_statement_sync.checked_at)`;
    });
    if (!data.next) return;
    await new Promise((resolve) => setTimeout(resolve, 1050));
  }
}

async function syncOphisReceipts() {
  const pending = await sql`SELECT e.recipient,e.paid_wei,b.safe_tx_hash,b.id FROM partner_fee_batch_entries e
    JOIN partner_fee_batches b ON b.id=e.batch_id WHERE b.status='executed' AND e.paid_wei>0 AND b.safe_tx_hash IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM partner_statement_receipts r WHERE r.recipient=e.recipient AND r.source='Ophis' AND r.transfer_id=b.id::text)`;
  for (const p of pending) {
    const rpc = getRpcClient(PARTNER_FEE_CHAIN);
    const receipt = await rpc.getTransactionReceipt({ hash: hex(p.safe_tx_hash) });
    if (receipt.status !== 'success') continue;
    const block = await rpc.getBlock({ blockHash: receipt.blockHash });
    await sql`INSERT INTO partner_statement_receipts (recipient,chain_id,source,transfer_id,tx,paid_at,asset,atoms)
      VALUES (${p.recipient},${PARTNER_FEE_CHAIN},'Ophis',${String(p.id)},${p.safe_tx_hash},${new Date(Number(block.timestamp) * 1000)},'WETH',${p.paid_wei})
      ON CONFLICT DO NOTHING`;
  }
}

async function syncPrices() {
  const rows = await sql`SELECT * FROM partner_statement_receipts WHERE usd IS NULL ORDER BY paid_at DESC`;
  for (const r of rows) {
    const token: Hex = r.source === 'Ophis' ? WETH_GNOSIS : payoutChains[r.chain_id]!.wrapper;
    try {
      const usd = await priceDefiLlamaFill({
        chainId: r.chain_id,
        sellToken: token,
        sellAmount: BigInt(r.atoms),
        settlementTimestamp: r.paid_at,
      });
      await sql`UPDATE partner_statement_receipts SET usd=${usd} WHERE recipient=${r.recipient} AND chain_id=${r.chain_id}
        AND source=${r.source} AND transfer_id=${r.transfer_id}`;
    } catch (err) {
      logger.warn({ err, chain: r.chain_id }, 'partner receipt price pending');
    }
  }
}

async function syncHostedAssessments() {
  const pending =
    await sql`SELECT f.chain_id,f.block_number,f.log_index,f.trade_uid,f.transaction_hash,t.own_fee_recipient
    FROM trades t JOIN defillama_fills f USING(chain_id,trade_uid)
    LEFT JOIN partner_statement_assessments a ON (a.chain_id,a.block_number,a.log_index,a.trade_uid,a.recipient)=
      (f.chain_id,f.block_number,f.log_index,f.trade_uid,t.own_fee_recipient)
    WHERE t.own_fee_recipient IS NOT NULL AND t.own_fee_bps>0 AND t.fee_verified AND f.fee_verified AND f.transaction_hash IS NOT NULL
      AND f.chain_id=ANY(${hostedChains}::int[])
      AND (a.checked_at IS NULL OR (a.atoms IS NULL AND a.checked_at < now()-interval '1 day'))
    ORDER BY a.checked_at NULLS FIRST,f.settlement_timestamp DESC LIMIT 350`;
  for (const r of pending) {
    const uid = hex(r.trade_uid);
    let token: Address | null = null,
      atoms: bigint | null = null;
    try {
      const order = await getOrder(r.chain_id, uid);
      if (order.uid.toLowerCase() !== uid) throw new Error('Order UID mismatch');
      const full = order.fullAppData || (await resolveAppData(r.chain_id, order.appData as Hex));
      if (!full || keccak256(stringToHex(full)) !== order.appData.toLowerCase())
        throw new Error('App data digest mismatch');
      const raw: unknown = JSON.parse(full)?.metadata?.partnerFee;
      const policies = z.array(z.object({ recipient: address }).passthrough()).parse(Array.isArray(raw) ? raw : [raw]);
      for (let offset = 0; ; offset += 1000) {
        const fills = await listTrades({ chainId: r.chain_id, orderUid: uid, offset });
        const fill = fills.find(
          (f) =>
            f.orderUid.toLowerCase() === uid &&
            BigInt(f.blockNumber) === BigInt(r.block_number) &&
            f.logIndex === r.log_index &&
            f.txHash.toLowerCase() === hex(r.transaction_hash),
        );
        if (fill) {
          const fees = executedRecipientFees(policies, fill.executedProtocolFees ?? [], hex(r.own_fee_recipient));
          if (fees?.length && fees.every((f) => f.token.toLowerCase() === fees[0]!.token.toLowerCase())) {
            token = fees[0]!.token.toLowerCase() as Address;
            atoms = fees.reduce((sum, f) => sum + BigInt(f.amount), 0n);
          }
          break;
        }
        if (fills.length < 1000) break;
      }
    } catch (err) {
      logger.warn({ err, chain: r.chain_id }, 'partner fill evidence pending');
    }
    await sql`INSERT INTO partner_statement_assessments (chain_id,block_number,log_index,trade_uid,recipient,token,atoms)
      VALUES (${r.chain_id},${r.block_number},${r.log_index},${r.trade_uid},${r.own_fee_recipient},${token && buf(token)},${atoms?.toString() ?? null})
      ON CONFLICT (chain_id,block_number,log_index,trade_uid,recipient) DO UPDATE SET checked_at=now(),
        token=COALESCE(excluded.token,partner_statement_assessments.token),atoms=COALESCE(excluded.atoms,partner_statement_assessments.atoms)`;
  }
}

async function syncTokenUnits() {
  const pending = await sql`WITH tokens AS (
    SELECT chain_id,fee_token AS token FROM partner_fee_trades
    UNION SELECT chain_id,token FROM partner_statement_assessments WHERE token IS NOT NULL
  ) SELECT t.* FROM tokens t LEFT JOIN partner_statement_tokens known USING(chain_id,token) WHERE known.token IS NULL`;
  for (const r of pending) {
    const token = hex(r.token);
    try {
      const native = token === ethAddress;
      const rpc = getRpcClient(r.chain_id);
      const decimals = native
        ? 18
        : await rpc.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
      const name = native
        ? payoutChains[r.chain_id]?.symbol
        : await rpc.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => null);
      const symbol = typeof name === 'string' && /^[a-z0-9._-]{1,24}$/i.test(name) ? name : null;
      await sql`INSERT INTO partner_statement_tokens VALUES (${r.chain_id},${r.token},${decimals},${symbol}) ON CONFLICT DO NOTHING`;
    } catch (err) {
      logger.warn({ err, chain: r.chain_id }, 'partner token units pending');
    }
  }
}

export async function syncPartnerStatements() {
  const due =
    await sql`SELECT r.recipient,c.chain,COALESCE(s.next_nonce,0) AS next_nonce FROM (SELECT DISTINCT own_fee_recipient AS recipient FROM trades WHERE fee_verified
    AND own_fee_bps>0 AND own_fee_recipient IS NOT NULL AND chain_id=ANY(${hostedChains}::int[])) r
    CROSS JOIN unnest(${Object.keys(payoutChains).map(Number)}::int[]) AS c(chain)
    LEFT JOIN partner_statement_sync s ON s.recipient=r.recipient AND s.chain_id=c.chain
    WHERE s.checked_at IS NULL OR s.checked_at < now()-interval '4 hours' ORDER BY s.checked_at NULLS FIRST, c.chain`;
  for (const r of due) {
    try {
      await syncReceipts(r.recipient, r.chain, r.next_nonce);
    } catch (err) {
      logger.warn({ err, chain: r.chain }, 'partner payout coverage pending');
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  await syncOphisReceipts();
  await syncPrices();
  await syncHostedAssessments();
  await syncTokenUnits();
}

export function startPartnerStatementSync() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncPartnerStatements();
    } catch (err) {
      logger.error({ err }, 'partner statement refresh failed');
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), 15 * 60_000).unref();
}
