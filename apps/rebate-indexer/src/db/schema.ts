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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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

    // Verified gross Ophis flat fee rate (bps), decoded from appData. Capped
    // improvement is excluded: executedProtocolFees is intended rather than
    // recipient-reconciled revenue and cannot safely fund affiliate payouts.
    // Three states:
    //   N (1..10)  = verified historical flat rate; post-cutover rows are 1 bp;
    //   0         = examined, NO settled Ophis fee at all (a backend-rejected shape
    //               like capped {volumeBps,maxVolumeBps} or both-aliases, a non-Ophis
    //               recipient, an absent/0-bps fee) -> credited at ZERO;
    //   NULL      = unknown; covers a pre-per-trade historical row, unparseable
    //               appData, OR a valid surplus/price-improvement fee. Accrual uses
    //               the separately persisted order-creation policy marker.
    // 0 vs NULL is load-bearing: the marker fallback keeps 0 as 0 (no credit).
    // The self-healing backfill only upgrades
    // NULL -> a POSITIVE rate, so re-fetching history never reclassifies it to 0.
    volumeFeeBps: integer('volume_fee_bps'),

    // API-derived policy version for a NULL volumeFeeBps. Computed exclusively
    // from order.creationDate: 10 before the 1 bp rollout, 1 afterward. NULL means
    // a decoder-first row has not been API-enriched and must be held from accrual.
    undecodedFeeFallbackBps: integer('undecoded_fee_fallback_bps'),

    // True when volume_fee_bps is AUTHORITATIVE: an API row fetched under the
    // owner-allowlist, or an on-chain-verified decoder row. False for a settle()
    // decoder DISCOVERY row whose volume_fee_bps is a provisional 0 (catalog-only,
    // credits nothing). Governs the fetcher backfill/skip logic ONLY (migration 0013);
    // the money path keys on volume_fee_bps, never on this column. DEFAULT true so
    // pre-0013 rows (all API-fetched) read as verified.
    feeVerified: boolean('fee_verified').notNull().default(true),

    // Affiliate referral code from the order's appData (metadata.ophisReferrer.code),
    // normalized + grammar-validated by the fetcher. NULL when the order carried no
    // code. Accrual attributes such a trade to the code owner (migration 0009).
    appdataRefCode: text('appdata_ref_code'),

    // Basket (multi-order) marker from appData (metadata.ophisBasket.id), grammar-
    // validated (32-hex) by the fetcher. NULL when the order was not a basket leg.
    // Pure analytics passthrough: NOT fee-gated (earns no rebate), no FK, written on
    // INSERT only (immutable on the upsert conflict). Lets basket volume be grouped
    // and measured after the fact (migration 0020, basket-intents Phase A).
    basketId: text('basket_id'),

    // Integrator OWN-FEE (partner-fee stacking, migration 0014). CoW's partnerFee is
    // an ARRAY; an integrator can stack their own recipient entry next to the Ophis
    // base entry. These capture the FIRST non-Ophis flat-Volume entry so
    // GET /earnings/:appCode can report what an integrator's own routing earned.
    //   own_fee_bps       = the integrator's own flat Volume rate, clamped to
    //                       [1, OWN_FEE_MAX_BPS]; NULL when no non-Ophis flat-Volume
    //                       entry was present.
    //   own_fee_recipient = the integrator's own-fee recipient (where it paid out);
    //                       NULL when own_fee_bps is NULL.
    // Decoded on EVERY chain (the fetcher has the full appData); only the
    // paid/guaranteed labeling is sovereign-scoped (see src/earnings.ts).
    ownFeeBps: integer('own_fee_bps'),
    ownFeeRecipient: bytea('own_fee_recipient'),

    // Own-fee SCAN MARKER (migration 0016). NULL means the row has NOT yet been scanned
    // for a stacked integrator own-fee; a timestamp means it has (whether or not one was
    // found). This is the backfillOwnFee work-queue state. NEVER overload own_fee_bps
    // for it (own_fee_bps IS NULL keeps meaning "no flat own-fee recorded"). The insert/
    // upsert path stamps this so a freshly-indexed row never enters the backfill queue;
    // the backfill stamps it so every row is scanned at most once and the queue drains.
    ownFeeScannedAt: timestamp('own_fee_scanned_at', { withTimezone: true }),

    // Exact-UID reporting audit (migration 0039). Aggregate trades store one
    // order total, while defillama_fills stores every settlement event. Readiness
    // requires the persisted expected count to match the fill ledger so one fill
    // cannot make a multi-fill order look complete.
    defillamaExpectedFillCount: integer('defillama_expected_fill_count'),
    defillamaRepairCheckedAt: timestamp('defillama_repair_checked_at', { withTimezone: true }),

    valueUsd: numeric('value_usd', { precision: 20, scale: 4 }),
    pricedAt: timestamp('priced_at', { withTimezone: true }),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    walletTimeIdx: index('trades_wallet_time_idx').on(t.wallet, t.blockTimestamp),
    unpricedIdx: index('trades_unpriced_idx').on(t.pricedAt),
    defillamaRepairIdx: index('trades_defillama_repair_pending_idx')
      .on(t.defillamaRepairCheckedAt, t.chainId),
  }),
);

// Settlement-fill ledger used only for public DefiLlama reporting. Unlike `trades`
// (one aggregate row per order for rebate scoring), this preserves every partial fill
// and its actual settlement block time so daily volume is never bucketed by creation.
export const defillamaFills = pgTable(
  'defillama_fills',
  {
    chainId: integer('chain_id').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    logIndex: integer('log_index').notNull(),
    tradeUid: bytea('trade_uid').notNull(),
    // Immutable settlement identity used by DefiLlama's daily transaction and
    // active-user metrics. Nullable only while migration backfill is converging;
    // the public endpoint fails closed if a verified row is missing either field.
    transactionHash: bytea('transaction_hash'),
    userAddress: bytea('user_address'),
    settlementTimestamp: timestamp('settlement_timestamp', { withTimezone: true }).notNull(),
    sellToken: bytea('sell_token').notNull(),
    sellAmount: uint256('sell_amount').notNull(),
    buyToken: bytea('buy_token'),
    buyAmount: uint256('buy_amount'),
    volumeFeeBps: integer('volume_fee_bps'),
    // Reporting-only assessed Ophis fee rate, including improvement capture.
    // Numeric preserves fractional bps. It never enters affiliate accrual.
    assessedFeeBps: numeric('assessed_fee_bps', { precision: 20, scale: 8 }),
    feeVerified: boolean('fee_verified').notNull(),
    valueUsd: numeric('value_usd', { precision: 20, scale: 4 }),
    pricedAt: timestamp('priced_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chainId, t.blockNumber, t.logIndex, t.tradeUid] }),
    unpricedIdx: index('defillama_fills_unpriced_idx').on(t.chainId, t.blockNumber, t.logIndex),
    dailyIdx: index('defillama_fills_daily_idx').on(t.settlementTimestamp, t.chainId),
    chainUidIdx: index('defillama_fills_chain_uid_idx').on(t.chainId, t.tradeUid),
    txIdx: index('defillama_fills_tx_idx').on(t.transactionHash),
    userIdx: index('defillama_fills_user_idx').on(t.userAddress),
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

// Singleton publication heartbeat (migration 0037). Updated only after the
// scorer has successfully refreshed the public `wallets` materialized view.
export const publicDataRefreshState = pgTable('public_data_refresh_state', {
  singleton: boolean('singleton').primaryKey().default(true),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
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

// --- Sovereign integrator OWN-FEE payout (migration 0017) --------------------
// Deliberately SEPARATE from BOTH the rebate and affiliate tables so rebate,
// affiliate and own-fee recipient addresses + amounts are never mixed. UNLIKE
// rebate/affiliate (Gnosis-only), own-fee pays on the SOVEREIGN chain the volume
// routed on, so the batch carries chain_id and uniqueness is (cycle_month, chain_id).
// See migrations/0017_own_fee_batches.sql for the contract.

// One own-fee payout batch per (cycle month, chain). Column types mirror affiliate_batches.
export const ownFeeBatches = pgTable(
  'own_fee_batches',
  {
    id: serial('id').primaryKey(),
    cycleMonth: date('cycle_month').notNull(),
    chainId: integer('chain_id').notNull(),
    totalOwedWei: uint256('total_owed_wei').notNull(),
    wethUsdPrice: numeric('weth_usd_price', { precision: 20, scale: 4 }),
    status: text('status').notNull(),
    safeProposalHash: bytea('safe_proposal_hash'),
    safeTxHash: bytea('safe_tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cycleChainUq: uniqueIndex('own_fee_batches_cycle_chain_uq').on(t.cycleMonth, t.chainId),
  }),
);

// One row per own-fee recipient paid in a cycle+chain. Mirrors affiliate_batch_entries.
export const ownFeeBatchEntries = pgTable(
  'own_fee_batch_entries',
  {
    batchId: integer('batch_id')
      .notNull()
      .references(() => ownFeeBatches.id),
    // The own_fee_recipient = the on-chain WETH payout address.
    recipient: bytea('recipient').notNull(),
    owedWei: uint256('owed_wei').notNull(),
    paidWei: uint256('paid_wei'),
    status: text('status').notNull().default('pending'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batchId, t.recipient] }),
    recipientIdx: index('own_fee_entries_recipient_idx').on(t.recipient),
  }),
);

// ─── Self-serve PARTNER-FEE program (partner-fees Phase B, migration 0019) ────
// Deliberately SEPARATE from the rebate / affiliate / own-fee tables so partner
// recipient addresses + amounts are never mixed. Fed by the restricted accrual feed
// (NOT the fetcher's per-owner trade scan), paid 80% monthly in WETH from the Ophis
// Safe (20% retained) via the same affiliate Safe rails (decision 18). Reopens audit
// finding C3/F6 on the money path. See migrations/0019_partner_fees.sql for the
// full column contract.

// Resumable position of the restricted partner-fee feed poller, per chain.
export const partnerFeeCursor = pgTable('partner_fee_cursor', {
  chainId: integer('chain_id').primaryKey(),
  nextBlock: bigint('next_block', { mode: 'bigint' }).notNull().default(0n),
  nextLogIndex: bigint('next_log_index', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Skipped (ambiguous) attributions whose rows the cursor advanced past — dropped fees no
// query can re-detect. Keyed by SETTLEMENT IDENTITY so re-fetches (crash before the cursor
// save, intentional rewinds) are idempotent, and resolved per chain by the operator
// (partner-fee-resolve-skips --chain). The accrual gate blocks while any row is unresolved.
export const partnerFeeSkips = pgTable(
  'partner_fee_skips',
  {
    chainId: integer('chain_id').notNull(),
    tradeUid: bytea('trade_uid').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    logIndex: bigint('log_index', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chainId, t.tradeUid, t.blockNumber, t.logIndex] }),
  }),
);

// One row per (settled fee-bearing trade, partner recipient). PK (trade_uid,
// recipient): a trade can carry up to 3 distinct partner recipients. Idempotent
// on re-ingest. fee_amount is the ACTUALLY-COLLECTED protocol fee (the money);
// fee_usd is priced from it and summed into the owed basis. batch_id != NULL means
// the trade has been accounted into a payout cycle (never counted twice).
export const partnerFeeTrades = pgTable(
  'partner_fee_trades',
  {
    tradeUid: bytea('trade_uid').notNull(),
    recipient: bytea('recipient').notNull(),
    chainId: integer('chain_id').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    logIndex: bigint('log_index', { mode: 'bigint' }).notNull(),
    volumeBps: integer('volume_bps').notNull(),
    feeToken: bytea('fee_token').notNull(),
    feeAmount: uint256('fee_amount').notNull(),
    valueUsd: numeric('value_usd', { precision: 20, scale: 4 }),
    feeUsd: numeric('fee_usd', { precision: 20, scale: 4 }),
    pricedAt: timestamp('priced_at', { withTimezone: true }),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }),
    batchId: integer('batch_id').references(() => partnerFeeBatches.id),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // PK includes settlement identity (chain, block, log) so a partiallyFillable order's
    // multiple settlements each persist (see migration 0019). recipient distinguishes multiple
    // partners on one trade.
    pk: primaryKey({ columns: [t.tradeUid, t.recipient, t.chainId, t.blockNumber, t.logIndex] }),
    recipientIdx: index('partner_fee_trades_recipient_idx').on(t.recipient),
  }),
);

// One partner payout batch per cycle month (mirrors affiliate_batches). total_owed_wei
// is the WETH actually proposed for payout (Σ paid entries), NOT the whole owed.
export const partnerFeeBatches = pgTable('partner_fee_batches', {
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

// One row per recipient per cycle. status ∈ {paid, carried, quarantined}. owed_wei is
// present on every status (paid amount; carried/quarantined snapshot for the liability
// reservation). carried_usd is the authoritative USD carry-forward (0 for paid).
export const partnerFeeBatchEntries = pgTable(
  'partner_fee_batch_entries',
  {
    batchId: integer('batch_id')
      .notNull()
      .references(() => partnerFeeBatches.id),
    recipient: bytea('recipient').notNull(),
    owedUsd: numeric('owed_usd', { precision: 20, scale: 4 }).notNull(),
    owedWei: uint256('owed_wei').notNull().default(0n),
    carriedUsd: numeric('carried_usd', { precision: 20, scale: 4 }).notNull().default('0'),
    paidWei: uint256('paid_wei'),
    status: text('status').notNull(),
    // The batch whose accrual FOLDED this carried/quarantined entry into its owed (NULL =
    // not yet folded => still counted by the liability rollup + the next carry read).
    foldedIntoBatchId: integer('folded_into_batch_id').references(() => partnerFeeBatches.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batchId, t.recipient] }),
    recipientIdx: index('partner_fee_batch_entries_recipient_idx').on(t.recipient),
  }),
);

// Reward claims (migration 0025). One row per (wallet, reward): who claimed which
// partner perk, and the email the partner mails the code to. Re-claiming UPDATES
// the row (email correction) rather than duplicating it.
//
// `email` is collected for one purpose only: contacting the claimer about this
// reward (in practice, handing it to the named partner to send the code). Not a
// marketing list. `signature`/`issued` keep the EIP-191 ownership proof
// re-verifiable offline.
export const rewardClaims = pgTable(
  'reward_claims',
  {
    wallet: bytea('wallet').notNull(),
    rewardId: text('reward_id').notNull(),
    email: text('email').notNull(),
    // Server-computed XP at claim time (never taken from the client).
    xpAtClaim: bigint('xp_at_claim', { mode: 'number' }).notNull(),
    signature: text('signature').notNull(),
    issued: bigint('issued', { mode: 'number' }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.wallet, t.rewardId] }),
    rewardUpdatedIdx: index('reward_claims_reward_updated_idx').on(t.rewardId, t.updatedAt),
  }),
);
