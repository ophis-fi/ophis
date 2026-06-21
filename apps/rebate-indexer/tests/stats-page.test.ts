import { describe, it, expect } from 'vitest';
import { renderStatsPage, type PublicStats } from '../src/stats-page.js';

const sample: PublicStats = {
  totalVolumeUsd: 1234567.89,
  totalTrades: 4321,
  distinctTraders: 210,
  chainsActive: 3,
  byChain: [
    { chainId: 10, volumeUsd: 1000000, trades: 4000 },
    { chainId: 8453, volumeUsd: 234567.89, trades: 300 },
    { chainId: 1, volumeUsd: 0, trades: 21 },
  ],
  generatedAt: '2026-06-21T15:00:00.000Z',
};

describe('renderStatsPage', () => {
  it('renders the cumulative totals + per-chain rows with mapped chain names', () => {
    const html = renderStatsPage(sample);
    expect(html).toContain('$1,234,568'); // volume settled (rounded, thousands separators)
    expect(html).toContain('4,321'); // trades
    expect(html).toContain('210'); // traders
    expect(html).toContain('Optimism');
    expect(html).toContain('Base');
    expect(html).toContain('Ethereum');
    expect(html).toContain('Updated 2026-06-21 15:00 UTC');
  });

  it('shows a placeholder when no volume is indexed yet', () => {
    expect(renderStatsPage({ ...sample, byChain: [] })).toContain('No settled volume indexed yet');
  });

  it('maps an unknown chain id to a generic label', () => {
    expect(renderStatsPage({ ...sample, byChain: [{ chainId: 99999, volumeUsd: 5, trades: 1 }] })).toContain('Chain 99999');
  });

  it('contains no em-dash (brand rule for served content)', () => {
    expect(renderStatsPage(sample)).not.toContain('—');
  });
});
