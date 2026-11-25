import { base58 } from '@scure/base';
import postgres from 'postgres';
import { historicalCoinUsd } from '../pricer.js';
import { logger } from '../logger.js';

// Mainnet deployment manifest and one public settlement from the beginning of its history.
// The anchor prevents using a devnet, test or freshly truncated orderbook as a coverage source.
const PROGRAM = 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h';
const STATE = '4Wk6R1t1KWEAKRZsFnJgdrWgoDjavFSBZwkm7RJHiyKg';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ANCHOR =
  '4cwtwkbLYEKqRvDvtsna3hFf8gUPRjsuHNBWoFWuxRKGNrTFjqBYuuQyqo2DyfTBTFDrFQcWE182uGE1CBZdwp8a';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const PAGE = 12;

type Cursor = { slot: string; sig: string; ix: number; uid: string };
type Fill = {
  auction_id: string | null;
  slot: string;
  tx_signature: Buffer;
  instruction_index: number;
  order_uid: Buffer;
  wallet: Buffer;
  order_pda: Buffer;
  sell_mint: Buffer;
  buy_mint: Buffer;
  sell_atoms: string;
  buy_atoms: string;
  kind: 'sell' | 'buy';
  protocol_fee: string | null;
  base_fee_atoms: string | null;
};
type TokenBalance = { accountIndex: number; mint: string; owner?: string };
type Receipt = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
};
export type SolanaRpc = <T>(method: string, params: unknown[]) => Promise<T>;
export function reportingRpc(url: string): SolanaRpc {
  return async <T>(method: string, params: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw Error(`Solana reporting RPC ${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number } };
    if (body.error || body.result === undefined)
      throw Error(
        `Solana reporting RPC ${method} failed (${body.error?.code ?? 'missing result'})`,
      );
    return body.result;
  };
}

function receiptTime(row: Fill, receipt: Receipt | null): number {
  if (
    !receipt ||
    !receipt.meta ||
    receipt.meta.err !== null ||
    receipt.slot !== Number(row.slot) ||
    !receipt.blockTime ||
    !Number.isSafeInteger(receipt.blockTime) ||
    receipt.transaction.signatures[0] !== base58.encode(row.tx_signature)
  )
    throw Error('Unverified Solana reporting receipt');
  const { message } = receipt.transaction;
  const loaded = receipt.meta.loadedAddresses;
  const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const ix = message.instructions[row.instruction_index];
  if (!ix || keys[ix.programIdIndex] !== PROGRAM || keys[ix.accounts[2]!] !== STATE)
    throw Error('Mainnet BeginSettle program/state mismatch');
  const begin = Buffer.from(base58.decode(ix.data));
  const n = begin[11] ?? 0;
  if (begin[0] !== 0 || n === 0 || begin.length < 12 + n) throw Error('Invalid BeginSettle layout');
  const finishIx = message.instructions[begin.readUInt16LE(1)];
  if (
    !finishIx ||
    keys[finishIx.programIdIndex] !== PROGRAM ||
    keys[finishIx.accounts[1]!] !== STATE
  )
    throw Error('Mainnet FinalizeSettle program/state mismatch');
  const finish = Buffer.from(base58.decode(finishIx.data));
  if (
    finish.length !== 3 + 9 * n ||
    finish[0] !== 1 ||
    finish.readUInt16LE(1) !== row.instruction_index
  )
    throw Error('Unpaired FinalizeSettle');
  // The on-chain ABI sorts PDAs. Each order has three fixed accounts plus one per
  // pull; FinalizeSettle has one output push for each order at the same position.
  const balances = [
    ...(receipt.meta.preTokenBalances ?? []),
    ...(receipt.meta.postTokenBalances ?? []),
  ];
  let account = 5,
    amountOffset = 12 + n;
  const orderAddress = base58.encode(row.order_pda);
  for (let i = 0; i < n; i++) {
    const count = begin[12 + i]!;
    if (keys[ix.accounts[account]!] === orderAddress) {
      const source = balances.find((b) => b.accountIndex === ix.accounts[account + 1] && b.owner);
      const destIndex = finishIx.accounts[4 + 3 * i + 1];
      const dest = balances.find((b) => b.accountIndex === destIndex);
      if (
        source?.owner !== base58.encode(row.wallet) ||
        source.mint !== base58.encode(row.sell_mint) ||
        (dest ? dest.mint !== base58.encode(row.buy_mint) : base58.encode(row.buy_mint) !== SOL)
      )
        throw Error('On-chain owner or mint mismatch');
      let sold = 0n;
      for (let j = 0; j < count; j++) sold += begin.readBigUInt64LE(amountOffset + 8 * j);
      if (
        sold !== BigInt(row.sell_atoms) ||
        finish.readBigUInt64LE(3 + n + 8 * i) !== BigInt(row.buy_atoms)
      )
        throw Error('On-chain settled amounts differ from orderbook');
      return receipt.blockTime;
    }
    account += 3 + count;
    amountOffset += 8 * count;
  }
  throw Error('Order PDA missing from settlement');
}

async function readPage(source: postgres.Sql, from: Cursor | null, until: string): Promise<Fill[]> {
  return source<Fill[]>`
    WITH page AS MATERIALIZED (
      SELECT t.slot,t.tx_signature,t.instruction_index,t.order_uid,t.sell_amount,t.buy_amount,
             o.owner AS wallet, o.order_pda, o.sell_token AS sell_mint, o.buy_token AS buy_mint, o.kind, s.auction_id
      FROM solana.trades t LEFT JOIN solana.orders o ON o.uid=t.order_uid
      LEFT JOIN solana.settlements s USING (tx_signature,instruction_index)
      WHERE t.slot <= ${until} AND o.owner IS DISTINCT FROM ${Buffer.from(base58.decode(STATE))}
        AND (t.slot,t.tx_signature,t.instruction_index,t.order_uid) >
            (${from?.slot ?? '-1'}::bigint,decode(${from?.sig ?? ''},'hex'),${from?.ix ?? -1},decode(${from?.uid ?? ''},'hex'))
      ORDER BY t.slot,t.tx_signature,t.instruction_index,t.order_uid LIMIT ${PAGE}
    )
    SELECT t.auction_id::text,t.slot::text,t.tx_signature,t.instruction_index,t.order_uid,t.wallet,t.order_pda,t.sell_mint,t.buy_mint,t.kind,
      t.sell_amount::text AS sell_atoms,t.buy_amount::text AS buy_atoms,f.protocol_fee::text,
      CASE WHEN p.base_amount <= f.protocol_fee AND q.signed_fee_reference AND p.rate IN (0.0001,0.0005) AND f.protocol_fee >= 0
        AND f.fee_mint = CASE t.kind WHEN 'sell' THEN t.buy_mint ELSE t.sell_mint END
        AND p.policy_count = 2 AND p.volume_order < p.improvement_order
        AND (t.kind='sell' OR t.sell_amount >= f.protocol_fee)
        THEN p.base_amount::text
        END AS base_fee_atoms
    FROM page t LEFT JOIN solana.executed_protocol_fees f USING (tx_signature,instruction_index,order_uid)
    LEFT JOIN solana.order_quotes q ON q.order_uid=t.order_uid
    LEFT JOIN LATERAL (
      SELECT trunc(max(volume_factor::numeric) FILTER (WHERE kind='volume') *
               (CASE t.kind WHEN 'sell' THEN t.buy_amount+f.protocol_fee ELSE t.sell_amount-f.protocol_fee END)) AS base_amount,
             count(*) policy_count, max(volume_factor::numeric) FILTER (WHERE kind='volume') rate,
             max(application_order) FILTER (WHERE kind='volume') volume_order,
             max(application_order) FILTER (WHERE kind='priceimprovement' AND price_improvement_factor=0.5 AND price_improvement_max_volume_factor IN (0.002,0.0099)) improvement_order
      FROM solana.fee_policies WHERE auction_id=t.auction_id AND order_uid=t.order_uid
    ) p ON true
    ORDER BY t.slot,t.tx_signature,t.instruction_index,t.order_uid`;
}

const isStable = (token: string) => token === USDC || token === USDT;
type Price = typeof historicalCoinUsd;
async function prices(row: Fill, timestamp: number, price: Price) {
  const sell = base58.encode(row.sell_mint),
    buy = base58.encode(row.buy_mint);
  const sellAtoms = BigInt(row.sell_atoms),
    buyAtoms = BigInt(row.buy_atoms);
  const feeMint = row.kind === 'sell' ? buy : sell;
  const quote = (mint: string, atoms: bigint) =>
    price(`solana:${mint === SOL ? WSOL : mint}`, atoms, timestamp).catch(() => null);
  let pricedSell = true;
  let valueUsd: number | null;
  if (isStable(sell)) valueUsd = Number(sellAtoms) / 1e6;
  else if (isStable(buy)) {
    pricedSell = false;
    valueUsd = Number(buyAtoms) / 1e6;
  } else {
    valueUsd = await quote(sell, sellAtoms);
    if (valueUsd === null) {
      pricedSell = false;
      valueUsd = await quote(buy, buyAtoms);
    }
  }
  let baseFeeUsd: number | null = null;
  if (row.base_fee_atoms !== null) {
    if (isStable(feeMint)) baseFeeUsd = Number(row.base_fee_atoms) / 1e6;
    else if (row.base_fee_atoms === '0') baseFeeUsd = 0;
    else if (valueUsd !== null) {
      // A cross-mint valuation uses the realized exchange rate before Ophis fees.
      // The indexed sell amount is gross and the buy amount is net.
      const fee = BigInt(row.protocol_fee!);
      const feeSideAtoms =
        row.kind === 'sell'
          ? buyAtoms + (pricedSell ? fee : 0n)
          : sellAtoms - (pricedSell ? 0n : fee);
      if (feeSideAtoms > 0n)
        baseFeeUsd = (valueUsd * Number(row.base_fee_atoms)) / Number(feeSideAtoms);
    }
  }
  return { valueUsd, baseFeeUsd };
}

type Sync = {
  tail: Cursor | null;
  repair: Cursor | null;
  covered_slot: string | null;
  covered_block_timestamp: Date | null;
};
export async function importSolanaFills(
  source: postgres.Sql,
  target: postgres.Sql,
  rpc: SolanaRpc,
  price = historicalCoinUsd,
) {
  return target.begin(async (tx) => {
    const [sync] = await tx<
      Sync[]
    >`SELECT * FROM solana_fill_sync WHERE singleton FOR UPDATE SKIP LOCKED`;
    if (!sync) return false;
    const [head] = await source<{ slot: string }[]>`
      SELECT least(slot,finalized_slot)::text AS slot FROM solana.indexer_state WHERE singleton
        AND EXISTS (SELECT 1 FROM solana.trades WHERE slot=473270143 AND tx_signature=${Buffer.from(base58.decode(ANCHOR))})`;
    if (!head || BigInt(head.slot) < BigInt(sync.covered_slot ?? 0))
      throw Error('Solana reporting source has incomplete mainnet history');
    const hasNewCoverage = head.slot !== sync.covered_slot;
    const receipts = new Map<string, Receipt | null>();
    let verifiedGenesis = false;
    async function verifyCluster() {
      if (!verifiedGenesis && (await rpc('getGenesisHash', [])) !== GENESIS)
        throw Error('Wrong Solana reporting network');
      verifiedGenesis = true;
    }
    async function processPage(from: Cursor | null, until: string) {
      let cursor = from;
      const rows = await readPage(source, from, until);
      for (const row of rows) {
        if (!row.order_pda || !row.wallet || row.auction_id === null)
          return { cursor, complete: false, stalled: true };
        const [known] = await tx<
          {
            block_timestamp: Date;
            value_usd: string | null;
            base_fee_atoms: string | null;
            base_fee_usd: string | null;
          }[]
        >`
          SELECT block_timestamp,value_usd,base_fee_atoms,base_fee_usd FROM solana_settled_fills
          WHERE tx_signature=${row.tx_signature} AND instruction_index=${row.instruction_index} AND order_uid=${row.order_uid}`;
        let timestamp = known ? Math.floor(new Date(known.block_timestamp).getTime() / 1000) : 0;
        if (!known) {
          try {
            await verifyCluster();
            const sig = base58.encode(row.tx_signature);
            if (!receipts.has(sig))
              receipts.set(
                sig,
                await rpc('getTransaction', [
                  sig,
                  { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 },
                ]),
              );
            timestamp = receiptTime(row, receipts.get(sig)!);
          } catch (err) {
            // Keep prior verified rows and retry from this exact point next tick.
            logger.warn(
              { slot: row.slot, reason: err instanceof Error ? err.message : 'RPC unavailable' },
              'Solana fill awaiting verification',
            );
            return { cursor, complete: false, stalled: true };
          }
        }
        if (
          !known ||
          known.value_usd === null ||
          known.base_fee_atoms !== row.base_fee_atoms ||
          (row.base_fee_atoms !== null && known.base_fee_usd === null)
        ) {
          const { valueUsd, baseFeeUsd } = await prices(row, timestamp, price);
          await tx`INSERT INTO solana_settled_fills
            (tx_signature,instruction_index,order_uid,slot,block_timestamp,wallet,sell_mint,buy_mint,sell_atoms,buy_atoms,value_usd,base_fee_atoms,base_fee_usd)
            VALUES (${row.tx_signature},${row.instruction_index},${row.order_uid},${row.slot},to_timestamp(${timestamp}),${row.wallet},
                    ${row.sell_mint},${row.buy_mint},${row.sell_atoms},${row.buy_atoms},${valueUsd},${row.base_fee_atoms},${baseFeeUsd})
            ON CONFLICT (tx_signature,instruction_index,order_uid) DO UPDATE SET
              value_usd=COALESCE(solana_settled_fills.value_usd,excluded.value_usd),
              base_fee_atoms=excluded.base_fee_atoms,base_fee_usd=excluded.base_fee_usd`;
        }
        cursor = {
          slot: row.slot,
          sig: row.tx_signature.toString('hex'),
          ix: row.instruction_index,
          uid: row.order_uid.toString('hex'),
        };
      }
      return { cursor, complete: rows.length < PAGE, stalled: false };
    }

    const tail = await processPage(sync.tail, head.slot);
    const repair =
      sync.covered_slot && tail.complete
        ? await processPage(sync.repair, sync.covered_slot)
        : { complete: false, cursor: sync.repair, stalled: false };
    await tx`UPDATE solana_fill_sync SET tail=${tail.cursor && tx.json(tail.cursor)},repair=${!repair.complete && repair.cursor ? tx.json(repair.cursor) : null}`;
    if (tail.stalled || repair.stalled) return false;
    if (!tail.complete) return true;
    let coveredTime = sync.covered_block_timestamp;
    if (hasNewCoverage) {
      try {
        await verifyCluster();
        const finalized = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
        if (!Number.isSafeInteger(finalized) || finalized < Number(head.slot))
          throw Error('Solana reporting RPC behind source');
        // An indexed boundary may be a skipped slot. Use the latest produced block at or below it.
        const headNumber = Number(head.slot);
        const blocks = await rpc<number[]>('getBlocks', [
          Math.max(0, headNumber - 64),
          headNumber,
          { commitment: 'finalized' },
        ]);
        const last = blocks.at(-1);
        if (last === undefined || last > headNumber || last < headNumber - 64)
          throw Error('No finalized block at boundary');
        const unix = await rpc<number | null>('getBlockTime', [last]);
        if (!unix || !Number.isSafeInteger(unix)) throw Error('Finalized slot time unavailable');
        coveredTime = new Date(unix * 1000);
      } catch (err) {
        logger.warn(
          { slot: head.slot, reason: err instanceof Error ? err.message : 'RPC unavailable' },
          'Solana coverage awaiting verification',
        );
        return false;
      }
    }
    await tx`UPDATE solana_fill_sync SET covered_slot=${head.slot},covered_block_timestamp=${coveredTime},checked_at=now()`;
    return false;
  });
}

export function startSolanaReporting() {
  const url = process.env.SOLANA_REPORTING_DATABASE_URL;
  if (!url) return;
  const source = postgres(url, {
    path: process.env.SOLANA_REPORTING_SOCKET || undefined,
    max: 1,
    connect_timeout: 5,
    idle_timeout: 30,
    connection: { default_transaction_read_only: true, statement_timeout: 8000 },
  });
  const rpc = reportingRpc(
    process.env.SOLANA_REPORTING_RPC_URL || 'https://api.mainnet-beta.solana.com',
  );
  async function tick() {
    let next = 60_000;
    try {
      const { sql } = await import('../db/index.js');
      if (await importSolanaFills(source, sql, rpc)) next = 250;
    } catch (err) {
      // A connection error can contain the private DSN. Log only the error class and SQLSTATE.
      logger.error(
        { kind: err instanceof Error ? err.name : 'Error', code: (err as { code?: string }).code },
        'Solana reporting failed',
      );
    } finally {
      setTimeout(() => void tick(), next).unref();
    }
  }
  void tick();
}
