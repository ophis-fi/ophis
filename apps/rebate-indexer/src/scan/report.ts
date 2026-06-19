import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Coverage, Swap } from './types.js';

export function fmtAmount(amount: string, decimals: number | null): string {
  if (decimals === null) return `${amount} (raw)`;
  const neg = amount.startsWith('-');
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

const leg = (l: Swap['sell']) => `${fmtAmount(l.amount, l.decimals)} ${l.symbol ?? l.token.slice(0, 10)}`;

export function renderTable(swaps: Swap[], coverage: Coverage[]): string {
  const lines: string[] = [];
  if (swaps.length === 0) {
    lines.push('No Ophis swaps in window.');
  } else {
    lines.push(`Ophis swaps: ${swaps.length}`);
    for (const s of swaps) {
      const usd = s.notionalUsd !== null ? `$${s.notionalUsd.toFixed(2)}` : 'n/a';
      lines.push(`  ${s.tsUtc}  ${s.chainName.padEnd(9)}  ${leg(s.sell)} -> ${leg(s.buy)}  (${usd})  ${s.orderUid.slice(0, 12)}...`);
    }
  }
  lines.push('');
  lines.push('Coverage:');
  for (const c of coverage) {
    const tail = c.status === 'ok'
      ? `scanned ${c.fillsScanned}, ophis ${c.ophisFound}, unresolved ${c.unresolved}`
      : `DEGRADED: ${c.error ?? 'unknown'}`;
    lines.push(`  ${c.chainName.padEnd(9)}  ${c.status.toUpperCase().padEnd(8)}  ${tail}`);
  }
  return lines.join('\n');
}

export function telegramSummary(swaps: Swap[], coverage: Coverage[], windowLabel: string): string {
  const totalUsd = swaps.reduce((a, s) => a + (s.notionalUsd ?? 0), 0);
  const degraded = coverage.filter((c) => c.status === 'degraded').map((c) => c.chainName);
  const head = `Ophis swap report (${windowLabel}): ${swaps.length} swaps, ~$${totalUsd.toFixed(2)} notional`;
  const top = swaps.slice(0, 5).map((s) => `- ${s.chainName}: ${leg(s.sell)} to ${leg(s.buy)}`);
  const warn = degraded.length ? `\nDegraded chains: ${degraded.join(', ')}` : '';
  return [head, ...top].join('\n') + warn;
}

export function defaultJsonPath(nowIso: string): string {
  return join(homedir(), '.ophis', 'scans', `scan-${nowIso.replace(/[:.]/g, '-')}.json`);
}

export async function writeJsonArtifact(
  path: string,
  payload: { window: string; generatedAt: string; swaps: Swap[]; coverage: Coverage[] },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}
