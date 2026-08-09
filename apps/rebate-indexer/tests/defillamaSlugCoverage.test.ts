import { describe, it, expect } from 'vitest';
import { DEFILLAMA_CHAIN_SLUG } from '../src/pricer.js';
import { PRODUCTION_CHAIN_IDS, CHAIN_NAME } from '../src/stats-page.js';

// fetcher.ts builds DEFILLAMA_CHAIN_IDS as `new Set(PRODUCTION_CHAIN_IDS)`, so a
// settlement fill row is created for EVERY production chain. priceDefiLlamaFill can
// only price a fill whose chain has a DefiLlama coins namespace. When the two sets
// drift, fills on the uncovered chain keep value_usd = NULL forever and
// completeDefiLlamaBackfillIfReady can never mark the backfill complete, so
// GET /defillama serves 503 indefinitely.
//
// That is exactly what happened to Robinhood Chain (4663): it was added to
// CHAIN_NAME (and therefore to the fill-producing set) without a coins namespace,
// and /defillama returned "backfill in progress" for every date.
describe('DefiLlama chain-slug coverage', () => {
  it('covers every production chain that produces settlement fills', () => {
    const uncovered = PRODUCTION_CHAIN_IDS.filter((id) => DEFILLAMA_CHAIN_SLUG[id] === undefined);
    expect(
      uncovered.map((id) => `${id} (${CHAIN_NAME[id] ?? 'unknown'})`),
      'every chain in PRODUCTION_CHAIN_IDS creates defillama_fills rows and so needs a coins namespace',
    ).toEqual([]);
  });

  it('maps no chain outside the production set', () => {
    const stray = Object.keys(DEFILLAMA_CHAIN_SLUG)
      .map(Number)
      .filter((id) => !PRODUCTION_CHAIN_IDS.includes(id));
    expect(stray).toEqual([]);
  });

  it('uses non-empty, lowercase namespaces', () => {
    for (const [id, slug] of Object.entries(DEFILLAMA_CHAIN_SLUG)) {
      expect(slug, `chain ${id}`).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
