// tests/scan/localDb.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLocalRows, buildLocalQuery, scanLocalDbChain } from '../../src/scan/sources/localDb.js';

const tsv = readFileSync(join(__dirname, 'fixtures', 'op-localdb-row.tsv'), 'utf8');

describe('parseLocalRows', () => {
  it('parses a real OP row into a Swap', () => {
    const [s, ...rest] = parseLocalRows(tsv, 10, 'optimism');
    expect(rest).toHaveLength(0);
    expect(s!.chainId).toBe(10);
    expect(s!.sell.token).toBe('0x4200000000000000000000000000000000000006');
    expect(s!.sell.amount).toBe('20000000000000000');
    expect(s!.buy.amount).toBe('34214818');
    expect(s!.appCode).toBe('ophis');
    expect(s!.feeBps).toBe(10);
    expect(s!.txHash).toBe('0xe315ae6193e796abf9247c4d3bc2dbca0fd02c2954bce1c8f41f3a8af7cdcf1b');
  });
  it('ignores blank lines', () => {
    expect(parseLocalRows('\n\n', 10, 'optimism')).toEqual([]);
  });
});

describe('buildLocalQuery', () => {
  it('filters by window and Ophis appCode', () => {
    const q = buildLocalQuery('2026-06-17T00:00:00Z');
    expect(q).toContain("2026-06-17T00:00:00Z");
    expect(q).toMatch(/appCode'\s*in\s*\('ophis','greg'\)/i);
  });
});

describe('scanLocalDbChain', () => {
  it('runs the injected psql runner and returns coverage', async () => {
    const run = async () => tsv;
    const res = await scanLocalDbChain({ chainId: 10, name: 'optimism', kind: 'local-db', dbContainer: 'optimism-mainnet-db-1' }, '2026-06-17T00:00:00Z', run);
    expect(res.coverage.status).toBe('ok');
    expect(res.coverage.ophisFound).toBe(1);
    expect(res.swaps).toHaveLength(1);
  });
  it('marks the chain degraded when psql throws', async () => {
    const run = async () => { throw new Error('container not running'); };
    const res = await scanLocalDbChain({ chainId: 10, name: 'optimism', kind: 'local-db', dbContainer: 'x' }, '2026-06-17T00:00:00Z', run);
    expect(res.coverage.status).toBe('degraded');
    expect(res.coverage.error).toContain('container not running');
  });
});
