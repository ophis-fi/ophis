import { describe, it, expect } from 'vitest';
import { parseSince, blockAtTimestamp, type BlockClient } from '../../src/scan/window.js';

describe('parseSince', () => {
  it('parses units', () => {
    expect(parseSince('48h')).toBe(48 * 3600);
    expect(parseSince('2d')).toBe(2 * 86400);
    expect(parseSince('90m')).toBe(90 * 60);
    expect(parseSince('30s')).toBe(30);
  });
  it('throws on garbage', () => {
    expect(() => parseSince('soon')).toThrow();
  });
  it('rejects a zero-length window', () => {
    expect(() => parseSince('0s')).toThrow();
    expect(() => parseSince('0h')).toThrow();
  });
});

describe('blockAtTimestamp', () => {
  // synthetic chain: block N has timestamp N*12, head = 1000
  const client: BlockClient = {
    getBlockNumber: async () => 1000n,
    getBlock: async ({ blockNumber }) => ({ timestamp: blockNumber * 12n }),
  };
  it('finds the first block at/after the target', async () => {
    expect(await blockAtTimestamp(client, 6000)).toBe(500n);  // 500*12 = 6000
    expect(await blockAtTimestamp(client, 6001)).toBe(501n);
  });
  it('returns head+1 when target is past the head', async () => {
    expect(await blockAtTimestamp(client, 999_999)).toBe(1001n);
  });
});
