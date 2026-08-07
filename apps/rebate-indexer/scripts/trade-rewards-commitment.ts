import { open } from 'node:fs/promises';
import { allocationCommitment, buildRewardAllocation, parseAllocationSeed } from '../src/tradeRewards/allocation.js';

const path = process.argv[2];
if (!path) throw new Error('usage: pnpm trade-rewards:commitment -- <0600-seed-file>');
const handle = await open(path, 'r');
let rawSeed: string;
try {
  const metadata = await handle.stat();
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('seed path must be a regular file with mode 0600 or stricter');
  }
  rawSeed = await handle.readFile('utf8');
} finally {
  await handle.close();
}
const seed = parseAllocationSeed(rawSeed.trim());
const allocation = buildRewardAllocation(seed);
process.stdout.write(`${allocationCommitment(seed, allocation)}\n`);
