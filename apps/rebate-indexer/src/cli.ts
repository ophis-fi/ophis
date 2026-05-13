import { runMigrations } from './db/migrate.js';
import { runFetcher } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher } from './batcher.js';
import { sql } from './db/index.js';
import { logger } from './logger.js';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';

const log = logger.child({ module: 'cli' });

async function blockTimestampLookup(_chainId: number, blockNumber: number): Promise<Date> {
  const client = createPublicClient({ chain: gnosis, transport: http(process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com') });
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  return new Date(Number(block.timestamp) * 1_000);
}

const cmds: Record<string, (args: string[]) => Promise<void>> = {
  async migrate() {
    await runMigrations();
  },
  async ['replay-from-genesis']() {
    await runMigrations();
    log.info('clearing derived state');
    await sql`TRUNCATE rebate_batch_entries, rebate_batches, trades RESTART IDENTITY CASCADE`;
    await runFetcher({ blockTimestampLookup });
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
