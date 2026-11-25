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
const receipts = new Map<string, unknown>();
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
    CREATE TABLE solana.orders(uid bytea,owner bytea,order_pda bytea,sell_token bytea,buy_token bytea,kind text,sell_token_account bytea,buy_token_account bytea);
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

it('verifies actual-output receipts before crediting volume or changing the eligible base fee', async () => {
  // The original fixture runs against V21. V22 adds nullable realized amounts;
  // old trades carry NULL and keep using the paired fixed-payout instructions.
  await sql.unsafe(`ALTER TABLE solana.trades ADD actual_gross numeric, ADD execution_cost numeric,
    ADD actual_base_fee numeric, ADD actual_improvement_fee numeric`);
  const orderUid = Buffer.from(
    '475e7a4def248cd582e7fab8e419f2bc595c1e34acb01e15694d870dff958eaf',
    'hex',
  );
  const orderAddress = 'AUm4A3ntjzytqfCV9fqdXyCDMkhs1ZXXrQuN48wPzNJu';
  const actualPda = Buffer.from(base58.decode(orderAddress));
  const keys = [
    prog,
    state,
    base58.encode(other),
    base58.encode(Buffer.alloc(32, 22)),
    orderAddress,
    base58.encode(Buffer.alloc(32, 33)),
    base58.encode(Buffer.alloc(32, 34)),
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    base58.encode(Buffer.alloc(32, 35)),
    base58.encode(Buffer.alloc(32, 36)),
  ];
  const signature = sig(111),
    index = 34,
    slot = firstSlot + index;
  const fee = 1157n;
  await sql`insert into solana.orders values(${orderUid},${trader},${actualPda},${Buffer.from(wrapped)},${Buffer.from(usdc)},'sell',${other},${Buffer.from(base58.decode(keys[3]!))})`;
  await sql`insert into solana.trades values(${slot},${signature},2,${orderUid},40000000,2701612,2703187,418,270,887)`;
  await sql`insert into solana.settlements values(${signature},2,66)`;
  await sql`insert into solana.executed_protocol_fees values(${signature},2,${orderUid},${String(fee)},${Buffer.from(usdc)})`;
  await sql`update solana.indexer_state set slot=${slot},finalized_slot=${slot}`;
  const begin = Buffer.alloc(21);
  begin[0] = 13;
  begin.writeUInt16LE(4, 1);
  begin.writeBigInt64LE(66n, 3);
  begin[11] = 1;
  begin[12] = 1;
  begin.writeBigUInt64LE(40_000_000n, 13);
  const end = Buffer.alloc(20);
  end[0] = 14;
  end.writeUInt16LE(2, 1);
  end[3] = 255;
  end.writeBigUInt64LE(2701493n, 4);
  end.writeBigUInt64LE(418n, 12);
  const proof = Buffer.alloc(80);
  proof.write('OPHISRC3');
  actualPda.copy(proof, 8);
  for (const [i, a] of [2703187n, 418n, 270n, 887n, 2701612n].entries())
    proof.writeBigUInt64LE(a, 40 + 8 * i);
  const transfer = (to: number, amount: bigint) => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(amount, 1);
    return { programIdIndex: 7, accounts: [5, to, 4], data: base58.encode(data) };
  };
  const noop = { programIdIndex: 7, accounts: [], data: '' };
  const good = {
    slot,
    blockTime: blockTime(slot),
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 2, mint: base58.encode(wrapped), owner: base58.encode(trader) },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: base58.encode(usdc), owner: base58.encode(trader) },
      ],
      returnData: { programId: prog, data: [proof.toString('base64'), 'base64'] },
      innerInstructions: [
        {
          index: 4,
          instructions: [
            transfer(3, 2701612n),
            transfer(6, 1575n),
            { programIdIndex: 7, accounts: [5, 8, 4], data: base58.encode(Uint8Array.of(9)) },
          ],
        },
      ],
    },
    transaction: {
      signatures: [base58.encode(signature)],
      message: {
        accountKeys: keys,
        instructions: [
          noop,
          noop,
          {
            programIdIndex: 0,
            accounts: [8, 9, 1, 7, 7, 4, 2, 7, 8, 5],
            data: base58.encode(begin),
          },
          noop,
          { programIdIndex: 0, accounts: [9, 1, 7, 4, 5, 6, 3, 8], data: base58.encode(end) },
        ],
      },
    },
  };
  const noPrice = async () => null;
  const imported = () =>
    sql`select value_usd::text,base_fee_atoms::text,base_fee_usd::text from solana_settled_fills where order_uid=${orderUid}`;
  const attempt = async (r: typeof good) => {
    receipts.set(base58.encode(signature), r);
    await importSolanaFills(sql, sql, rpc, noPrice);
  };
  const wrongProgramme = structuredClone(good);
  wrongProgramme.meta.returnData.programId = state;
  await attempt(wrongProgramme);
  expect(await imported()).toHaveLength(0);
  const wrongFees = structuredClone(good);
  const altered = Buffer.from(proof);
  altered.writeBigUInt64LE(888n, 64);
  wrongFees.meta.returnData.data[0] = altered.toString('base64');
  await attempt(wrongFees);
  expect(await imported()).toHaveLength(0);
  const wrongTransfers = structuredClone(good);
  wrongTransfers.meta.innerInstructions[0]!.instructions[0] = transfer(6, 2701612n);
  await attempt(wrongTransfers);
  expect(await imported()).toHaveLength(0);
  await attempt(good);
  expect(await imported()).toEqual([
    { value_usd: '2.701612', base_fee_atoms: '270', base_fee_usd: '0.00027' },
  ]);
  // Repairing a previously verified row cannot replace its on-chain fee with a
  // different amount merely because the source was subsequently edited.
  await sql`update solana.trades set actual_base_fee=271 where order_uid=${orderUid}`;
  await sql`update solana_fill_sync set repair=null`;
  for (let i = 0; i < 4; i++) await attempt(good);
  expect((await imported())[0]?.base_fee_atoms).toBe('270');
  await sql`update solana.trades set actual_base_fee=270 where order_uid=${orderUid}`;

  // Native output closes the order's wrapped-SOL stage into the fee buffer and
  // the settlement program directly credits lamports to the signed destination.
  const nativeUid = Buffer.alloc(32, 80);
  const nativeAddress = 'HSexk2xXpjHbLUNf9G7gx4NsuM8xn4yoq67E8R1ZyrUF';
  const nativePda = Buffer.from(base58.decode(nativeAddress));
  const nativeSig = sig(112);
  const nativeMint = Buffer.alloc(32);
  const native = structuredClone(good);
  native.slot = slot + 1;
  native.blockTime = blockTime(native.slot);
  native.transaction.signatures[0] = base58.encode(nativeSig);
  native.transaction.message.accountKeys[4] = nativeAddress;
  native.transaction.message.accountKeys[3] = base58.encode(trader);
  native.meta.preTokenBalances[0]!.mint = base58.encode(usdc);
  native.meta.postTokenBalances = [];
  const nativeProof = Buffer.from(proof);
  nativePda.copy(nativeProof, 8);
  native.meta.returnData.data[0] = nativeProof.toString('base64');
  const close = { programIdIndex: 7, accounts: [5, 6, 4], data: base58.encode(Uint8Array.of(9)) };
  native.meta.innerInstructions[0]!.instructions = [close];
  await sql`insert into solana.orders values(${nativeUid},${trader},${nativePda},${Buffer.from(usdc)},${nativeMint},'sell',${other},${trader})`;
  await sql`insert into solana.trades values(${native.slot},${nativeSig},2,${nativeUid},40000000,2701612,2703187,418,270,887)`;
  await sql`insert into solana.settlements values(${nativeSig},2,66)`;
  await sql`insert into solana.executed_protocol_fees values(${nativeSig},2,${nativeUid},${String(fee)},${nativeMint})`;
  await sql`update solana.indexer_state set slot=${native.slot},finalized_slot=${native.slot}`;
  const nativeImported = () =>
    sql`select value_usd,base_fee_atoms::text,base_fee_usd from solana_settled_fills where order_uid=${nativeUid}`;
  const wrongNative = structuredClone(native);
  wrongNative.meta.innerInstructions[0]!.instructions[0]!.accounts[1] = 8;
  receipts.set(base58.encode(nativeSig), wrongNative);
  await importSolanaFills(sql, sql, rpc, noPrice);
  expect(await nativeImported()).toHaveLength(0);
  receipts.set(base58.encode(nativeSig), native);
  await importSolanaFills(sql, sql, rpc, noPrice);
  const [nativeRow] = await nativeImported();
  expect(Number(nativeRow?.value_usd)).toBe(40);
  expect(nativeRow?.base_fee_atoms).toBe('270');
  expect(Number(nativeRow?.base_fee_usd)).toBeCloseTo((40 * 270) / 2703187, 12);
});
