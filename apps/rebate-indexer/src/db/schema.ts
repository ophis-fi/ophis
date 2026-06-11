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
  // The WETH this cycle distributes FROM: in POOL mode the POOL_SPLIT_BPS-of-balance
  // pool; in DIRECT mode the recomputed distributable (newFees), overwritten after the
  // accrual basis is resolved so /status, /batches and the reconciler don't read the
  // stale pool-split value written at insert. (NOT the amount actually paid — that is Σ entries.)
  poolWethWei: uint256('pool_weth_wei').notNull(),
  // DIRECT-mode accrual basis (REBATE_DIRECT_MODE, migration 0004): the Safe WETH
  // balance level already accounted for as of this cycle, so the NEXT cycle rebates
  // only (current balance - this) = the new fees. Set on direct-mode proposed
  // rows as balance - rebates PAID to good recipients (P2-4, PR #454: a
  // quarantined recipient's unpaid rebate stays in the Safe BELOW the basis and
  // is NOT redistributed — it is alerted for manual retry, never folded back
  // into a later cycle's delta) and on no_recipients rows (= full balance);
  // NULL on POOL-mode /
  // failed / computing rows. The next-cycle read takes the latest row with status
  // IN ('executed','no_recipients') — it deliberately ignores 'proposed' (basis is
  // optimistic until the payout settles) and 'failed' (reverted, never paid); a
  // pending-payout guard blocks a new direct cycle while a prior row is
  // proposed/proposing so the optimistic basis is only read once settled.
  feeBasisWethWei: uint256('fee_basis_weth_wei'),

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

// ─── Affiliate / Partner program (migration 0005) ───────────────────────────
// Deliberately SEPARATE from the rebate tables above so rebate and affiliate
// recipient addresses + amounts are never mixed. Same payout Safe, distinct
// proposal + reconciliation. See migrations/0005_affiliate.sql for the contract.

// Referral codes. Partner codes (kind='partner') are operator-seeded and their
// referrer_wallet IS the partner-dashboard whitelist; regular codes are self-served.
export const refCodes = pgTable(
  'ref_codes',
  {
    code: text('code').primaryKey(),
    referrerWallet: bytea('referrer_wallet').notNull(),
    // Optional payout redirect (migration 0007). NULL => pay to referrer_wallet.
    // referrer_wallet stays the IDENTITY (credit / whitelist); only the WETH
    // transfer recipient becomes COALESCE(payout_wallet, referrer_wallet).
    payoutWallet: bytea('payout_wallet'),
    kind: text('kind').notNull(), // 'regular' | 'partner' (CHECK in SQL)
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    referrerIdx: index('ref_codes_referrer_idx').on(t.referrerWallet),
  }),
);

// One referrer per referred wallet (PK), first-bind-wins, lifetime. net_new records
// the wallet had no prior Ophis trades at bind time (bind rejects non-net-new).
export const referrals = pgTable(
  'referrals',
  {
    referredWallet: bytea('referred_wallet').primaryKey(),
    code: text('code')
      .notNull()
      .references(() => refCodes.code),
    referrerWallet: bytea('referrer_wallet').notNull(),
    netNew: boolean('net_new').notNull(),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    referrerIdx: index('referrals_referrer_idx').on(t.referrerWallet),
    codeIdx: index('referrals_code_idx').on(t.code),
  }),
);

// Affiliate payout batches — separate from rebate_batches; same monthly cadence + Safe.
export const affiliateBatches = pgTable('affiliate_batches', {
  id: serial('id').primaryKey(),
  cycleMonth: date('cycle_month').notNull().unique(),
  totalOwedWei: uint256('total_owed_wei').notNull(),
  wethUsdPrice: numeric('weth_usd_price', { precision: 20, scale: 4 }),
  status: text('status').notNull(),
  safeProposalHash: bytea('safe_proposal_hash'),
  safeTxHash: bytea('safe_tx_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const affiliateBatchEntries = pgTable(
  'affiliate_batch_entries',
  {
    batchId: integer('batch_id')
      .notNull()
      .references(() => affiliateBatches.id),
    referrerWallet: bytea('referrer_wallet').notNull(),
    kind: text('kind').notNull(),
    referredVolumeUsd: numeric('referred_volume_usd', { precision: 20, scale: 4 }).notNull(),
    owedWei: uint256('owed_wei').notNull(),
    paidWei: uint256('paid_wei'),
    status: text('status').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batchId, t.referrerWallet] }),
    referrerIdx: index('affiliate_entries_referrer_idx').on(t.referrerWallet),
  }),
);
