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
    expect(html).toContain('100% of price improvement is returned to the trader');
  });

  it('states the exact fee and improvement split for sovereign and hosted chains', () => {
    const html = renderStatsPage(sample);
    expect(html).toContain('the Ophis fee is all-in (0.10% on the swap app, 0.05% for SDK and MCP partners; 0.01% on same-chain stable pairs)');
    expect(html).toContain('0.02% volume fee (0.003% on correlated pairs)');
    expect(html).toContain('retains 50% of quote improvement upstream, capped at 0.98% of volume');
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
  it('matches the sovereign driver configs: 4 solvers on Optimism, 8 competing on Unichain', () => {
    // Counts mirror the [[solver]] blocks in
    // infra/optimism-mainnet/configs/driver.toml.tmpl and
    // infra/unichain-mainnet/configs/driver.toml.tmpl.
    expect(EXECUTION_FACTS.solverCompetition.sovereignChains).toEqual([
      { chainId: 10, solvers: 4 },
      { chainId: 130, solvers: 8 },
    ]);
  });

  it('describes the settlement model and improvement split as static facts only', () => {
    expect(EXECUTION_FACTS.mevProtection).toBe('batch-auction');
    expect(EXECUTION_FACTS.settlementModel).toBe('intent, uniform clearing price');
    expect(EXECUTION_FACTS.solverCompetition.hostedChains).toBe('CoW Protocol solver network');
    expect(EXECUTION_FACTS.improvementSplit.sovereign).toBe('100% of price improvement returned to the trader');
    expect(EXECUTION_FACTS.improvementSplit.hosted).toBe('CoW Protocol retains 50% of quote improvement upstream');
  });
});

describe('PRODUCTION_CHAIN_IDS (public /stats allow-list)', () => {
  it('lists exactly the 12 named mainnet chains', () => {
    expect([...PRODUCTION_CHAIN_IDS].sort((a, b) => a - b)).toEqual([
      1, 10, 56, 100, 130, 137, 8453, 9745, 42161, 43114, 57073, 59144,
    ]);
  });

  it('excludes testnets (Sepolia 11155111) so dust never reaches the public surface', () => {
    expect(PRODUCTION_CHAIN_IDS).not.toContain(11155111);
  });
});
