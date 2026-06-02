import {
  pgTable,
  customType,
  integer,
  bigint,
  timestamp,
  text,
  serial,
  date,
  numeric,
  boolean,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

// uint256 stored as NUMERIC(78) — drizzle exposes string at the TS layer;
// we convert to bigint at use-site to stay lossless.
const uint256 = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(78,0)',
  toDriver: (v) => v.toString(),
  fromDriver: (v) => BigInt(v),
});

// Postgres BYTEA <-> 0x-hex string (lowercased). Wallet & token addresses are 20 bytes;
// trade_uid is 56 bytes (CoW order UID).
const bytea = customType<{ data: `0x${string}`; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.slice(2), 'hex'),
  fromDriver: (v) => `0x${v.toString('hex')}` as `0x${string}`,
});

export const trades = pgTable(
  'trades',
  {
    tradeUid: bytea('trade_uid').primaryKey(),
    chainId: integer('chain_id').notNull(),
    wallet: bytea('wallet').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),

    sellToken: bytea('sell_token').notNull(),
    buyToken: bytea('buy_token').notNull(),
    sellAmount: uint256('sell_amount').notNull(),
    buyAmount: uint256('buy_amount').notNull(),

    appCode: text('app_code').notNull(),
    partnerFeeWei: uint256('partner_fee_wei'),

    valueUsd: numeric('value_usd', { precision: 20, scale: 4 }),
    pricedAt: timestamp('priced_at', { withTimezone: true }),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    walletTimeIdx: index('trades_wallet_time_idx').on(t.wallet, t.blockTimestamp),
    unpricedIdx: index('trades_unpriced_idx').on(t.pricedAt),
  }),
);

// Owner registry the fetcher iterates. CoW's orderbook can only be queried
// per-owner (`/api/v1/trades?owner=`), so we keep the set of wallets to fetch
// here — populated by `GET /tier/:wallet` and seeded in migration 0001.
export const trackedWallets = pgTable('tracked_wallets', {
  wallet: bytea('wallet').primaryKey(),
  firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  // Stamped on a fully-successful fetch (all chains OK). Drives the 6h refresh
  // window and "this wallet has no Ophis trades" eviction.
  lastFetched: timestamp('last_fetched', { withTimezone: true }),
  // Stamped on EVERY fetch attempt (success or failure). Lets the prune tell a
  // wallet we tried-and-failed (keep, retry) from one we never reached (overflow).
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
});

export const rebateBatches = pgTable('rebate_batches', {
  id: serial('id').primaryKey(),
  cycleMonth: date('cycle_month').notNull().unique(),
  netFeeWethWei: uint256('net_fee_weth_wei').notNull(),
  poolWethWei: uint256('pool_weth_wei').notNull(),

  safeProposalHash: bytea('safe_proposal_hash'),
  safeTxHash: bytea('safe_tx_hash'),
  status: text('status').notNull().default('computing'),

  proposedAt: timestamp('proposed_at', { withTimezone: true }),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rebateBatchEntries = pgTable(
  'rebate_batch_entries',
  {
    batchId: integer('batch_id')
      .notNull()
      .references(() => rebateBatches.id),
    wallet: bytea('wallet').notNull(),
    volumeUsd: numeric('volume_30d_usd', { precision: 20, scale: 4 }).notNull(),
    tier: text('tier').notNull(),
    rebatePct: numeric('rebate_pct', { precision: 5, scale: 4 }).notNull(),
    wethAmountWei: uint256('weth_amount_wei').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batchId, t.wallet] }),
    walletIdx: index('rebate_entries_wallet_idx').on(t.wallet),
  }),
);

// Append-only nightly-completion heartbeat: one row per COMPLETED runPipelineSteps
// (the cron path only — the startup backfill does NOT call it). Lets /health
// witness the 02:00 UTC tick (and, via first_of_month, the monthly batcher) without
// the admin-gated /status, and survives redeploys (unlike last_fetch_attempt). See
// migration 0003_pipeline_runs.sql.
export const pipelineRuns = pgTable('pipeline_runs', {
  id: serial('id').primaryKey(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  // true ONLY when the monthly batcher STEP actually executed this run (set from
  // cron.ts `batcherRan`) — NOT merely that it was the 1st. A skipped batcher
  // (e.g. missing proposer key) leaves this false so /health.last_batcher_run_at
  // never falsely claims the batcher ticked.
  firstOfMonth: boolean('first_of_month').notNull().default(false),
});

// `wallets` is a MATERIALIZED VIEW (not modelled as a drizzle table) —
// created by the raw SQL migration 0000_init.sql. Query via `sql\`SELECT … FROM wallets\``.
