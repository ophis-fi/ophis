import { runMigrations } from './db/migrate.js';
import { runFetcher, backfillOwnFee, withPipelineLock } from './fetcher.js';
import { runPricer } from './pricer.js';
import { completeDefiLlamaBackfillIfReady } from './defillamaBackfill.js';
import { runScorer } from './scorer.js';
import { runBatcher } from './batcher.js';
import { runPartnerFeeFetch } from './partnerFees/fetch.js';
import { runPartnerFeePricer } from './partnerFees/pricePartnerFees.js';
import { accruePartnerFees, proposePartnerFeeBatches } from './partnerFees/payout.js';
import { outstandingPartnerLiabilityWei } from './partnerFees/liability.js';
import { sql } from './db/index.js';
import { logger } from './logger.js';
import { privateKeyToAccount } from 'viem/accounts';

const log = logger.child({ module: 'cli' });

const cmds: Record<string, (args: string[]) => Promise<void>> = {
  async migrate() {
    await runMigrations();
  },
  // One-shot run of the fetch -> price -> score pipeline for the tracked
  // wallets. Useful for manual backfills / verification without waiting for
  // the nightly cron. Idempotent (trades upsert onConflictDoNothing).
  async fetch() {
    const { inserted } = await runFetcher();
    log.info({ inserted }, 'fetch complete');
    await runPricer();
    await runScorer();
  },
  // One-time backfill of the reporting-only own-fee columns (migration 0014) onto
  // verified rows indexed before 0014. Re-fetches one order per scanned row, so it
  // runs out of band, never in the nightly fetch. Optional --limit=<n> per run.
  async ['backfill-own-fee'](args) {
    const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
    const limit = limitArg ? Number(limitArg) : 500;
    const { scanned, updated } = await backfillOwnFee(Number.isFinite(limit) && limit > 0 ? limit : 500);
    log.info({ scanned, updated }, 'backfill-own-fee complete');
  },
  // One-shot repair of trades mis-stored with wallet = an eth-flow router
  // (see src/repair/routerTrades.ts): re-attributes each order to its receiver
  // via the CoW API, removes the routers from the fetch queues, then re-scores
  // so the rebate ranking reflects the repair immediately. Idempotent; the
  // nightly cron also runs it, so this exists for out-of-band verification.
  async ['repair-router-trades']() {
    const { repairRouterTrades } = await import('./repair/routerTrades.js');
    const result = await repairRouterTrades();
    log.info(result, 'repair-router-trades complete');
    // Queue cleanup can make the fail-closed DefiLlama gate ready immediately.
    // Do not require an operator to wait for (or manually emulate) nightly cron.
    await completeDefiLlamaBackfillIfReady();
    // Unconditional: a PRIOR partially-failed invocation (rows updated, then the
    // cleanup or scorer threw) leaves the matview stale while a retry reports
    // repaired = 0, so gating the refresh on this run's count would skip it.
    await runScorer();
  },
  // Register a wallet in the owner registry so the next fetch backfills it.
  async ['track-wallet'](args) {
    const addr = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase();
    if (!addr) throw new Error('usage: track-wallet 0x<40 hex>');
    await sql`INSERT INTO tracked_wallets (wallet) VALUES (decode(${addr.slice(2)}, 'hex')) ON CONFLICT (wallet) DO NOTHING`;
    log.info({ wallet: addr }, 'wallet tracked');
  },
  async ['replay-from-genesis']() {
    await runMigrations();
    log.info('clearing derived state');
    await sql`TRUNCATE rebate_batch_entries, rebate_batches, defillama_fills, trades RESTART IDENTITY CASCADE`;
    await sql`UPDATE defillama_reporting_state SET backfill_started_at = now(), completed_at = NULL WHERE singleton = true`;
    await sql`TRUNCATE defillama_backfill_wallets`;
    await sql`INSERT INTO defillama_backfill_wallets (wallet) SELECT wallet FROM tracked_wallets`;
    // Reset the fetch cursor too: runFetcher only re-fetches wallets whose
    // last_fetched is NULL or older than 6h. After a truncate, a replay run
    // shortly after the nightly fetch would otherwise skip every recently-
    // fetched wallet and rebuild an empty/partial ledger. Clearing last_fetched
    // forces a full re-fetch of all tracked wallets from scratch.
    await sql`UPDATE tracked_wallets SET last_fetched = NULL`;
    // runFetcher processes at most MAX_OWNERS_PER_RUN owners per call, so loop
    // until a run finds no eligible owners — otherwise a registry larger than
    // the per-run cap would only be partially rebuilt. Bounded guard against a
    // persistently-failing owner that never advances its cursor.
    for (let i = 0; i < 100; i++) {
      const { owners } = await runFetcher();
      if (owners === 0) break;
      if (i === 99) log.warn('replay-from-genesis fetch loop hit guard limit (persistently-failing owners?)');
    }
    await runPricer();
    await completeDefiLlamaBackfillIfReady();
    await runScorer();
  },
  async ['replay-pricer'](args) {
    const sinceArg = args.find((a) => a.startsWith('--since='))?.split('=')[1];
    if (sinceArg) {
      await sql`UPDATE trades SET value_usd = NULL, priced_at = NULL WHERE block_timestamp > ${sinceArg}::timestamptz`;
    }
    await runPricer();
  },
  async ['simulate-batch'](args) {
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY ?? ('0x' + '00'.repeat(32)) as `0x${string}`;
    const rpcUrl = args.find((a) => a.startsWith('--fork-rpc='))?.split('=')[1] ?? (process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com');
    const result = await runBatcher({
      chainId: 100,
      rpcUrl,
      proposerPrivateKey: proposerKey as `0x${string}`,
      proposeEnabled: false,
    });
    console.log(JSON.stringify({
      ...result,
      poolWei: result.poolWei.toString(),
      poolWeth: (Number(result.poolWei) / 1e18).toFixed(5),
    }, null, 2));
  },
  async ['dry-run-monthly']() {
    await cmds['simulate-batch']!([]);
  },
  // One-shot partner-fee feed poll + price (partner-fees Phase B). Idempotent; needs
  // PARTNER_FEE_FEED_URLS configured or it is a no-op. Under the PIPELINE LOCK: a manual
  // fetch racing the monthly accrual could commit a priced trade between accrual's fee sum
  // and its trade stamp -- the stamp would consume a fee no cycle ever counted. Every
  // partner_fee_trades writer and the accrual itself serialize on this lock.
  async ['partner-fee-fetch']() {
    const ran = await withPipelineLock(async () => {
      const f = await runPartnerFeeFetch();
      const p = await runPartnerFeePricer();
      log.info({ ...f, ...p }, 'partner-fee fetch+price complete');
    });
    if (!ran) log.error('pipeline lock busy (nightly run or another command in progress); retry later');
  },
  // Record the settled-month partner-fee ledger (flag/key-independent). Establishes the
  // outstanding liability the rebate/affiliate batchers reserve. Same lock discipline as
  // partner-fee-fetch (accrual is the other side of the same race).
  async ['partner-fee-accrue']() {
    const ran = await withPipelineLock(async () => {
      const r = await accruePartnerFees({});
      const liability = await outstandingPartnerLiabilityWei();
      log.info({ ...r, outstandingLiabilityWei: liability.toString() }, 'partner-fee accrual complete');
    });
    if (!ran) log.error('pipeline lock busy (nightly run or another command in progress); retry later');
  },
  // Resolve the durable skipped-attribution markers for ONE chain, AFTER reconciling that
  // chain's dropped fees (re-cursor or manual accounting). The accrual completeness gate
  // blocks while any skip is unresolved (migration 0022). CHAIN-SCOPED on purpose: with
  // skips on several feed chains, an unqualified clear would reopen the gate while another
  // chain's dropped fees remain unaccounted -- run once per reconciled chain. Invoked with
  // no argument it only LISTS the unresolved skips (safe default, mutates nothing).
  async ['partner-fee-resolve-skips'](args) {
    const chainArg = args.find((a) => a.startsWith('--chain='))?.split('=')[1];
    const chainId = chainArg === undefined ? undefined : Number(chainArg);
    if (chainArg !== undefined && (!Number.isInteger(chainId) || chainId! <= 0)) {
      throw new Error(`--chain must be a positive integer chain id; got "${chainArg}"`);
    }
    const ran = await withPipelineLock(async () => {
      const open = await sql<{ chain_id: number; n: string }[]>`
        SELECT chain_id, COUNT(*)::text AS n FROM partner_fee_skips WHERE resolved_at IS NULL GROUP BY chain_id ORDER BY chain_id
      `;
      if (open.length === 0) {
        log.info('no unresolved partner-fee skips');
        return;
      }
      if (chainId === undefined) {
        log.error({ unresolved: open.map((r) => ({ chainId: r.chain_id, skips: parseInt(r.n, 10) })) }, 'unresolved partner-fee skips by chain; re-run with --chain=<id> AFTER reconciling that chain (nothing cleared)');
        return;
      }
      const cleared = await sql<{ trade_uid: Buffer; block_number: string }[]>`
        UPDATE partner_fee_skips SET resolved_at = now()
        WHERE chain_id = ${chainId} AND resolved_at IS NULL
        RETURNING trade_uid, block_number::text AS block_number
      `;
      if (cleared.length === 0) {
        log.info({ chainId }, 'no unresolved partner-fee skips on this chain');
        return;
      }
      log.warn(
        { chainId, resolved: cleared.map((r) => ({ uid: `0x${r.trade_uid.toString('hex')}`, block: r.block_number })) },
        'partner-fee skips RESOLVED by operator for this chain (accrual gate re-opens once every chain is clear)',
      );
    });
    if (!ran) log.error('pipeline lock busy (nightly run or another command in progress); retry later');
  },
  // Dry-run the monthly partner-fee payout (accrue, then propose in dry-run mode — records the
  // ledger + dry-runs transfers, never submits a Safe tx). Locked: contains an accrual.
  async ['partner-fee-dry-run']() {
    const ran = await withPipelineLock(async () => {
      await accruePartnerFees({});
      const rpcUrl = process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
      const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY ?? (('0x' + '00'.repeat(32)) as `0x${string}`);
      const r = await proposePartnerFeeBatches({ rpcUrl, proposerPrivateKey: proposerKey as `0x${string}`, proposeEnabled: false });
      console.log(JSON.stringify(r, null, 2));
    });
    if (!ran) log.error('pipeline lock busy (nightly run or another command in progress); retry later');
  },
  async ['rotate-proposer'](args) {
    const newKey = args.find((a) => a.startsWith('--new-key='))?.split('=')[1];
    if (!newKey) throw new Error('--new-key=0x... required');
    // L-02 fix (audit 2026-05-13): derive + print the public address instead
    // of leaking the first 40 bits of the private key. The whole point of
    // this hint line is to let the operator confirm the address Safe expects.
    const newAddress = privateKeyToAccount(newKey as `0x${string}`).address;
    console.log('To complete rotation:');
    console.log('1. Update SAFE_PROPOSER_PRIVATE_KEY in the Aleph VM env');
    console.log('2. Add new proposer in Safe UI: Settings → Transaction service → Add proposer');
    console.log('3. Remove old proposer from Safe Transaction Service');
    console.log(`4. The new proposer address ${newAddress} must match the Safe-recorded proposer EOA`);
  },
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const handler = cmd ? cmds[cmd] : undefined;
  if (!handler) {
    console.error('Usage: cli.ts <command>');
    console.error('Commands:', Object.keys(cmds).join(', '));
    process.exit(2);
  }
  await handler(rest);
  await sql.end();
}

main().catch((err) => {
  log.fatal({ err }, 'cli failed');
  process.exit(1);
});
