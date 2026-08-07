import { describe, expect, it } from 'vitest';
import { walletAgeEvidenceOnChain } from '../../src/tradeRewards/walletAge.js';

function historicalClient(nonce: number, code: `0x${string}` | undefined = '0x') {
  const timestamps = [0n, 100n, 200n, 300n, 400n, 500n];
  return {
    async getBlockNumber(): Promise<bigint> { return 5n; },
    async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<{ timestamp: bigint }> {
      return { timestamp: timestamps[Number(blockNumber)] ?? 0n };
    },
    async getTransactionCount(): Promise<number> { return nonce; },
    async getCode(): Promise<`0x${string}` | undefined> { return code; },
  };
}

describe('wallet age verification', () => {
  const wallet = '0x0000000000000000000000000000000000000001' as const;

  it('uses the last block at or before the cutoff and accepts historical activity', async () => {
    const evidence = await walletAgeEvidenceOnChain(
      wallet,
      1,
      new Date(350_000),
      historicalClient(2),
    );
    expect(evidence).toMatchObject({ chainId: 1, cutoffBlock: 3n, historicalNonce: 2 });
  });

  it('accepts a smart wallet deployed before the cutoff', async () => {
    const evidence = await walletAgeEvidenceOnChain(
      wallet,
      1,
      new Date(350_000),
      historicalClient(0, '0x6000'),
    );
    expect(evidence?.hadContractCode).toBe(true);
  });

  it('rejects an address with neither nonce nor code at the cutoff', async () => {
    await expect(
      walletAgeEvidenceOnChain(wallet, 1, new Date(350_000), historicalClient(0)),
    ).resolves.toBeNull();
  });
});
