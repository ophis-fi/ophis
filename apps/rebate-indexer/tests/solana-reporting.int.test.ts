import { readFileSync } from 'node:fs';
import { base58 } from '@scure/base';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { importSolanaFills, type SolanaRpc } from '../src/solana/fills.js';
import { startPg, stopPg } from './fixtures/pgContainer.js';

let container: Awaited<ReturnType<typeof startPg>>['container'];
let sql: postgres.Sql;
const firstSlot = 473270143;
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const anchor = base58.decode(
  '4cwtwkbLYEKqRvDvtsna3hFf8gUPRjsuHNBWoFWuxRKGNrTFjqBYuuQyqo2DyfTBTFDrFQcWE182uGE1CBZdwp8a',
);
const state = '4Wk6R1t1KWEAKRZsFnJgdrWgoDjavFSBZwkm7RJHiyKg';
const prog = 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h';
const usdc = base58.decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const trader = Buffer.alloc(32, 9),
  uid = Buffer.alloc(32, 11),
  pda = Buffer.alloc(32, 21);
const other = Buffer.alloc(32, 24),
  wrapped = base58.decode('So11111111111111111111111111111111111111112');
const sig = (i: number) => (i === 0 ? Buffer.from(anchor) : Buffer.alloc(64, i));
const blockTime = (slot: number) => 1_795_500_000 + slot - firstSlot;
const receipts = new Map<string, ReturnType<typeof receipt>>();
function receipt(i: number) {
  const begin = Buffer.alloc(21);
  begin.writeUInt16LE(1, 1);
  begin[11] = 1;
  begin[12] = 1;
  begin.writeBigUInt64LE(1_000_000n, 13);
  const end = Buffer.alloc(12);
  end[0] = 1;
  end.writeBigUInt64LE(40_000n, 4);
  return {
    slot: firstSlot + i,
    blockTime: blockTime(firstSlot + i),
    meta: {
      err: null,
      loadedAddresses: { writable: [base58.encode(pda)], readonly: [] },
      preTokenBalances: [
        { accountIndex: 2, mint: base58.encode(usdc), owner: base58.encode(trader) },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: base58.encode(wrapped), owner: base58.encode(trader) },
      ],
    },
    transaction: {
      signatures: [base58.encode(sig(i))],
      message: {
        accountKeys: [
          prog,
          state,
          base58.encode(Buffer.alloc(32, 40)),
          base58.encode(Buffer.alloc(32, 41)),
        ],
        instructions: [
          { programIdIndex: 0, accounts: [1, 1, 1, 1, 1, 4, 2, 2, 1], data: base58.encode(begin) },
          { programIdIndex: 0, accounts: [1, 1, 1, 1, 1, 3, 3], data: base58.encode(end) },
        ],
      },
    },
  };
}
const rpc: SolanaRpc = async <T>(method: string, params: unknown[]) => {
  const result: unknown =
    method === 'getTransaction'
      ? (receipts.get(String(params[0])) ?? null)
      : method === 'getSlot'
        ? firstSlot + 99
        : method === 'getGenesisHash'
          ? genesis
          : method === 'getBlocks'
            ? [Number(params[1]) - 1]
            : method === 'getBlockTime'
              ? blockTime(Number(params[0]))
              : undefined;
  if (result === undefined) throw Error('unexpected RPC method');
  return result as T;
};
beforeAll(async () => {
  const pg = await startPg();
  container = pg.container;
  sql = postgres(pg.connectionUri, { max: 3, onnotice: () => {} });
  drizzle(sql); // Install the same serializers the running rebate service uses.
  await sql.unsafe(
    readFileSync(new URL('../migrations/0054_solana_settled_fills.sql', import.meta.url), 'utf8'),
  );
  await sql.unsafe(`
    CREATE SCHEMA solana;
    CREATE TABLE solana.indexer_state(singleton boolean,slot bigint,finalized_slot bigint);
    CREATE TABLE solana.trades(slot bigint,tx_signature bytea,instruction_index int,order_uid bytea,sell_amount numeric,buy_amount numeric);
    CREATE TABLE solana.orders(uid bytea,owner bytea,order_pda bytea,sell_token bytea,buy_token bytea,kind text);
    CREATE TABLE solana.settlements(tx_signature bytea,instruction_index int,auction_id bigint);
    CREATE TABLE solana.executed_protocol_fees(tx_signature bytea,instruction_index int,order_uid bytea,protocol_fee numeric,fee_mint bytea);
    CREATE TABLE solana.order_quotes(order_uid bytea,signed_fee_reference boolean);
    CREATE TABLE solana.fee_policies(auction_id bigint,order_uid bytea,application_order int,kind text,volume_factor double precision,price_improvement_factor double precision,price_improvement_max_volume_factor double precision);`);
  await sql`insert into solana.indexer_state values(true,${firstSlot + 30},${firstSlot + 25})`;
  await sql`insert into solana.orders values(${uid},${trader},${pda},${Buffer.from(usdc)},${Buffer.from(wrapped)},'sell')`;
  await sql`insert into solana.order_quotes values(${uid},true)`;
  for (let i = 0; i < 27; i++) {
    await sql`insert into solana.trades values(${firstSlot + i},${sig(i)},0,${uid},1000000,40000)`;
    await sql`insert into solana.settlements values(${sig(i)},0,${i})`;
    await sql`insert into solana.executed_protocol_fees values(${sig(i)},0,${uid},10,${Buffer.from(wrapped)})`;
    await sql`insert into solana.fee_policies values(${i},${uid},1,'volume',0.0001,null,null),(${i},${uid},2,'priceimprovement',null,0.5,0.0099)`;
    receipts.set(base58.encode(sig(i)), receipt(i));
  }
  const treasuryUid = Buffer.alloc(32, 17);
  await sql`insert into solana.orders values(${treasuryUid},${Buffer.from(base58.decode(state))},${other},${Buffer.from(usdc)},${Buffer.from(wrapped)},'sell')`;
  await sql`insert into solana.trades values(${firstSlot},${sig(88)},0,${treasuryUid},1000000,40000)`;
}, 120000);
afterAll(async () => {
  await sql?.end();
  await stopPg(container);
});
it('backfills partial fills, rejects invalid receipts, withholds unknown fees and repairs late history', async () => {
  const count = async () =>
    Number((await sql`select count(*) from solana_settled_fills`)[0]!.count);
  const coverage = async () =>
    (await sql`select covered_slot,covered_block_timestamp from solana_fill_sync`)[0]!;
  const noPrices = async () => null;
  const poison = receipt(3);
  poison.meta.preTokenBalances[0]!.owner = base58.encode(other);
  receipts.set(base58.encode(sig(3)), poison);
  expect(await importSolanaFills(sql, sql, rpc, noPrices)).toBe(false);
  expect(await count()).toBe(3);
  expect((await coverage()).covered_slot).toBeNull();
  const badAmounts = receipt(3);
  const end = Buffer.from(base58.decode(badAmounts.transaction.message.instructions[1]!.data));
  end.writeBigUInt64LE(41_000n, 4);
  badAmounts.transaction.message.instructions[1]!.data = base58.encode(end);
  receipts.set(base58.encode(sig(3)), badAmounts);
  await importSolanaFills(sql, sql, rpc, noPrices);
  expect(await count()).toBe(3);

  receipts.set(base58.encode(sig(3)), receipt(3));
  expect(await importSolanaFills(sql, sql, rpc, noPrices)).toBe(true); // Catch-up schedules another page immediately.
  expect((await coverage()).covered_slot).toBeNull();
  while (await importSolanaFills(sql, sql, rpc, noPrices)) {}
  expect(await count()).toBe(26);
  expect((await coverage()).covered_slot).toBe(String(firstSlot + 25));
  expect(new Date((await coverage()).covered_block_timestamp)).toEqual(
    new Date(1000 * blockTime(firstSlot + 24)),
  );
  expect(
    (
      await sql`select sum(value_usd)::text vol,sum(base_fee_atoms)::text base from solana_settled_fills`
    )[0],
  ).toEqual({ vol: '26', base: '104' });
  const unknownUid = Buffer.alloc(32, 71),
    mint = Buffer.alloc(32, 88),
    key = sig(77);
  const late = receipt(0);
  late.transaction.signatures = [base58.encode(key)];
  late.meta.preTokenBalances[0]!.mint = base58.encode(mint);
  receipts.set(base58.encode(key), late);
  await sql`insert into solana.orders values(${unknownUid},${trader},${pda},${mint},${Buffer.from(wrapped)},'sell')`;
  await sql`insert into solana.trades values(${firstSlot},${key},0,${unknownUid},1000000,40000)`;
  await sql`insert into solana.settlements values(${key},0,48)`;
  // A retrospective source row behind the tail is recovered by the bounded repair scan.
  await sql`delete from solana.fee_policies where auction_id=0 and kind='volume'`;
  for (let i = 0; i < 4; i++) await importSolanaFills(sql, sql, rpc, noPrices);
  expect(await count()).toBe(27);
  expect(
    (
      await sql`select value_usd,base_fee_usd from solana_settled_fills where order_uid=${unknownUid}`
    )[0],
  ).toEqual({ value_usd: null, base_fee_usd: null });
  expect(
    (await sql`select base_fee_usd from solana_settled_fills where tx_signature=${sig(0)}`)[0]!
      .base_fee_usd,
  ).toBeNull();
  let priceTime = 0;
  const recoveredPrice = async (_coin: string, _amount: bigint, time: number) => {
    priceTime = time;
    return 3;
  };
  for (let i = 0; i < 4; i++) await importSolanaFills(sql, sql, rpc, recoveredPrice);
  expect(priceTime).toBe(blockTime(firstSlot));
  expect(
    (
      await sql`select value_usd::text as price from solana_settled_fills where order_uid=${unknownUid}`
    )[0]!.price,
  ).toBe('3');
  expect(await count()).toBe(27);
});
