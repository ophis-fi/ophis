export function parseSince(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad --since '${s}'; use e.g. 48h, 2d, 90m, 30s`);
  const n = Number(m[1]);
  // A zero-length window is a caller mistake: reject it rather than silently
  // scanning a degenerate range.
  if (n === 0) throw new Error(`--since must be > 0 (got '${s}')`);
  const mult = m[2] === 's' ? 1 : m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 86400;
  return n * mult;
}

export interface BlockClient {
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getBlockNumber(): Promise<bigint>;
}

// Lowest block whose timestamp >= targetTsSec. If the head is older than the
// target (no blocks in window), returns head+1 so a getLogs(fromBlock=head+1)
// is a no-op rather than scanning history.
export async function blockAtTimestamp(client: BlockClient, targetTsSec: number): Promise<bigint> {
  const target = BigInt(targetTsSec);
  const head = await client.getBlockNumber();
  const headTs = (await client.getBlock({ blockNumber: head })).timestamp;
  if (headTs < target) return head + 1n;
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const ts = (await client.getBlock({ blockNumber: mid })).timestamp;
    if (ts < target) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}
