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
  it('maps a 0x (no-settlement) txHash to null', () => {
    const row = ['2026-06-18T20:36:27+00:00', '0xuid', '0xowner', '0xrecv', '0xsell', '0xbuy', '100', '200', '0x', '{"appCode":"ophis"}'].join('\t');
    const [s] = parseLocalRows(row, 10, 'optimism');
    expect(s!.txHash).toBeNull();
    expect(s!.appCode).toBe('ophis');
  });
  it('skips a malformed short row (fewer than 10 columns)', () => {
    expect(parseLocalRows('a\tb\tc', 10, 'optimism')).toEqual([]);
  });
});

describe('buildLocalQuery', () => {
  it('filters by window and Ophis appCode (case-insensitively)', () => {
    const q = buildLocalQuery('2026-06-17T00:00:00Z');
    expect(q).toContain("2026-06-17T00:00:00Z");
    // appCode is lower()-ed before the membership check so a capitalised "Ophis"
    // on-chain appCode is still selected.
    expect(q).toMatch(/lower\(.*->>'appCode'\)\s*in\s*\('ophis','greg'\)/i);
  });
  it('maps each trade to exactly ONE settlement via a LATERAL sub-select (no fan-out)', () => {
    const q = buildLocalQuery('2026-06-17T00:00:00Z');
    // The fixed mapping: same block, settlement log_index AFTER the trade, first one.
    expect(q).toMatch(/left join lateral/i);
    expect(q).toContain('s.block_number = t.block_number');
    expect(q).toContain('s.log_index > t.log_index');
    expect(q).toMatch(/order by s\.log_index asc[\s\S]*limit 1/i);
    // The old fan-out join (every trade x every settlement in the block) is gone.
    expect(q).not.toMatch(/left join settlements\s+s\s+on\s+s\.block_number\s*=\s*t\.block_number/i);
  });
  it('windows on settlement time with a creation-time fallback (not creation_timestamp alone)', () => {
    const q = buildLocalQuery('2026-06-17T00:00:00Z');
    // Lower bound is on the settled time (settlement_executions.start_timestamp),
    // falling back to creation_timestamp when settlement time is unavailable.
    expect(q).toMatch(/coalesce\(stl\.settled_at,\s*o\.creation_timestamp\)\s*>=/i);
    expect(q).toContain('settlement_executions');
  });
  it('falls the receiver back to the owner when orders.receiver is NULL', () => {
    const q = buildLocalQuery('2026-06-17T00:00:00Z');
    expect(q).toContain("encode(coalesce(o.receiver, o.owner),'hex')");
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
