import { readFile, stat } from 'node:fs/promises';
import { allocationCommitment, buildRewardAllocation, parseAllocationSeed } from '../src/tradeRewards/allocation.js';

const path = process.argv[2];
if (!path) throw new Error('usage: pnpm trade-rewards:commitment -- <0600-seed-file>');
const metadata = await stat(path);
if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
  throw new Error('seed path must be a regular file with mode 0600 or stricter');
}
const seed = parseAllocationSeed((await readFile(path, 'utf8')).trim());
const allocation = buildRewardAllocation(seed);
process.stdout.write(`${allocationCommitment(seed, allocation)}\n`);
