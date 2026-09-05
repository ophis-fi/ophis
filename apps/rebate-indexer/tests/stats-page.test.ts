import { describe, it, expect } from 'vitest';
import { renderStatsPage, PRODUCTION_CHAIN_IDS, EXECUTION_FACTS, type PublicStats } from '../src/stats-page.js';

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
  dataAsOf: '2026-06-21T14:58:00.000Z',
  dataFresh: true,
  dataStatus: 'fresh',
  dataStaleReason: null,
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
    expect(html).toContain('Data as of 2026-06-21 14:58 UTC');
  });

  it('shows a placeholder when no volume is indexed yet', () => {
    expect(renderStatsPage({ ...sample, byChain: [] })).toContain('No settled volume indexed yet');
  });

  it('warns visibly when the public snapshot is stale', () => {
    const html = renderStatsPage({
      ...sample,
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'refresh_overdue',
    });
    expect(html).toContain('Data refresh delayed.');
    expect(html).toContain('last successful publication at 2026-06-21 14:58 UTC');
  });

  it('does not present response generation time as publication time before the first refresh', () => {
    const html = renderStatsPage({
      ...sample,
      dataAsOf: null,
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'never_refreshed',
    });
    expect(html).toContain('Data publication time unavailable');
    expect(html).not.toContain('Data as of 2026-06-21 15:00 UTC');
  });

  it('maps an unknown chain id to a generic label', () => {
    expect(renderStatsPage({ ...sample, byChain: [{ chainId: 99999, volumeUsd: 5, trades: 1 }] })).toContain('Chain 99999');
  });

  it('contains no em-dash (brand rule for served content)', () => {
    expect(renderStatsPage(sample)).not.toContain('—');
  });

  it('is pure ASCII apart from that check (self-contained strict-CSP page)', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderStatsPage(sample)).toMatch(/^[\x00-\x7F]*$/);
  });

  it('leads with the per-trade guarantees, then per-chain table, then lifetime totals, then docs links', () => {
    const html = renderStatsPage(sample);
    const hero = html.indexOf('MEV-protected batch settlement');
    const byChain = html.indexOf('Settled volume by chain');
    const lifetime = html.indexOf('Lifetime settled volume, cumulative');
    const docs = html.indexOf('https://docs.ophis.fi/fees');
    expect(hero).toBeGreaterThan(-1);
    expect(byChain).toBeGreaterThan(hero);
    expect(lifetime).toBeGreaterThan(byChain);
    expect(docs).toBeGreaterThan(lifetime);
  });

  it('states every per-trade guarantee in the hero', () => {
    const html = renderStatsPage(sample);
    expect(html).toContain('MEV-protected batch settlement');
    expect(html).toContain('Hard signed limit price');
    expect(html).toContain('Gasless execution');
    expect(html).toContain('Solver competition on every order');
    expect(html).toContain('Optimism: 11, Unichain: 7, Robinhood Chain: 6');
    expect(html).not.toContain('On Unichain, 8 aggregator solvers');
    expect(html).toContain('The Ophis fee on every supported chain is a 0.01% (1 bp) base');
  });

  it('states the exact all-chain fee and improvement split', () => {
    const html = renderStatsPage(sample);
    expect(html).toContain('80% of reference-quote improvement on volatile pairs (99 bps cap)');
    expect(html).toContain('50% on stable pairs (20 bps cap)');
    expect(html).toContain('CoW-hosted chains also apply CoW Protocol fees upstream');
  });

  it('gives the lifetime totals their early-stage, on-chain-verifiable context line', () => {
    const html = renderStatsPage(sample);
    expect(html).toContain('lifetime totals since launch, not a rolling window');
    expect(html).toContain('verifiable by anyone');
  });

  it('links the fee model and comparison docs in the footer', () => {
    const html = renderStatsPage(sample);
    expect(html).toContain('https://docs.ophis.fi/fees');
    expect(html).toContain('https://docs.ophis.fi/comparison');
  });

  it('never leaks current-cycle 30d volume or payout timing (admin-only signals)', () => {
    const html = renderStatsPage(sample);
    expect(html).not.toMatch(/30[ -]?d/i);
    expect(html).not.toMatch(/payout/i);
    expect(html).not.toMatch(/rolling 30/i);
  });
});

describe('EXECUTION_FACTS (static execution-model facts on the public JSON)', () => {
  it('matches the sovereign driver configs', () => {
    // Counts mirror the [[solver]] blocks in
    // infra/optimism-mainnet/configs/driver.toml.tmpl and
    // infra/unichain-mainnet/configs/driver.toml.tmpl.
    expect(EXECUTION_FACTS.solverCompetition.sovereignChains).toEqual([
      { chainId: 10, solvers: 11 },
      { chainId: 130, solvers: 7 },
      { chainId: 4663, solvers: 6 },
    ]);
  });

  it('describes the settlement model and improvement split as static facts only', () => {
    expect(EXECUTION_FACTS.mevProtection).toBe('batch-auction');
    expect(EXECUTION_FACTS.settlementModel).toBe('intent, uniform clearing price');
    expect(EXECUTION_FACTS.solverCompetition.hostedChains).toBe('CoW Protocol solver network');
    expect(EXECUTION_FACTS.improvementSplit.sovereign).toBe('Ophis retains 80% of volatile improvement (99 bps cap) or 50% of stable improvement (20 bps cap)');
    expect(EXECUTION_FACTS.improvementSplit.hosted).toBe('The same Ophis capped capture applies, plus CoW Protocol quote-improvement fees upstream');
  });
});

describe('PRODUCTION_CHAIN_IDS (public /stats allow-list)', () => {
  it('lists exactly the 13 named mainnet chains', () => {
    expect([...PRODUCTION_CHAIN_IDS].sort((a, b) => a - b)).toEqual([
      1, 10, 56, 100, 130, 137, 4663, 8453, 9745, 42161, 43114, 57073, 59144,
    ]);
  });

  it('excludes testnets (Sepolia 11155111) so dust never reaches the public surface', () => {
    expect(PRODUCTION_CHAIN_IDS).not.toContain(11155111);
  });
});
