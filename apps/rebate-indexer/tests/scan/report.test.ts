import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fmtAmount, renderTable, telegramSummary, defaultJsonPath, writeJsonArtifact } from '../../src/scan/report.js';
import type { Swap, Coverage } from '../../src/scan/types.js';

const swap: Swap = {
  chainId: 1, chainName: 'ethereum', tsUtc: '2026-06-18T20:43:11Z', orderUid: '0xda3c', txHash: '0x5348',
  owner: '0xba3c', receiver: '0x0494',
  sell: { token: '0xc02a', symbol: 'WETH', decimals: 18, amount: '41000000000000000' },
  buy: { token: '0xdac1', symbol: 'USDT', decimals: 6, amount: '69927413' },
  appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: 69.93,
};
const cov: Coverage[] = [{ chainId: 1, chainName: 'ethereum', status: 'ok', fillsScanned: 2880, ophisFound: 1, unresolved: 0 }];

describe('fmtAmount', () => {
  it('formats by decimals, raw when unknown', () => {
    expect(fmtAmount('41000000000000000', 18)).toBe('0.041');
    expect(fmtAmount('69927413', 6)).toBe('69.927413');
    expect(fmtAmount('123', null)).toBe('123 (raw)');
  });
});

describe('renderTable', () => {
  it('shows the swap and a coverage line, no em-dash', () => {
    const out = renderTable([swap], cov);
    expect(out).toContain('0.041 WETH');
    expect(out).toContain('69.927413 USDT');
    expect(out).toContain('ethereum');
    expect(out).not.toContain('—');
  });
  it('states when a window is empty', () => {
    expect(renderTable([], cov)).toContain('No Ophis swaps');
  });
});

describe('telegramSummary', () => {
  it('summarizes count + degraded chains', () => {
    const degraded: Coverage[] = [...cov, { chainId: 137, chainName: 'polygon', status: 'degraded', fillsScanned: 0, ophisFound: 0, unresolved: 0, error: 'rpc 429' }];
    const s = telegramSummary([swap], degraded, 'last 48h');
    expect(s).toContain('1');
    expect(s).toContain('polygon');
  });
});

describe('writeJsonArtifact', () => {
  it('defaults under ~/.ophis (out of repo)', () => {
    expect(defaultJsonPath('2026-06-19T09:00:00Z').startsWith(join(homedir(), '.ophis'))).toBe(true);
  });
  it('writes parseable JSON', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scan-')), 'r.json');
    await writeJsonArtifact(p, { window: 'last 48h', generatedAt: '2026-06-19T09:00:00Z', swaps: [swap], coverage: cov });
    const back = JSON.parse(readFileSync(p, 'utf8'));
    expect(back.swaps[0].orderUid).toBe('0xda3c');
  });
});
