import { runMigrations } from './db/migrate.js';
import { runFetcher, backfillOwnFee } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher } from './batcher.js';
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
    await sql`TRUNCATE rebate_batch_entries, rebate_batches, trades RESTART IDENTITY CASCADE`;
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
