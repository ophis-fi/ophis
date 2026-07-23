import { redactSecrets } from './redact.js';
import type { ChainConfig, Coverage, ScanResult, Swap } from './types.js';

export interface RunArgs {
  sinceSec: number;
  chains: ChainConfig[];
  nowSec: number;
}
export interface RunDeps {
  scanChain(cfg: ChainConfig): Promise<ScanResult>;
  enrich(swap: Swap): Promise<Swap>;
}

export async function runScan(args: RunArgs, deps: RunDeps): Promise<{ swaps: Swap[]; coverage: Coverage[] }> {
  const settled = await Promise.all(
    args.chains.map(async (cfg): Promise<ScanResult> => {
      try {
        return await deps.scanChain(cfg);
      } catch (err) {
        return {
          swaps: [],
          coverage: { chainId: cfg.chainId, chainName: cfg.name, status: 'degraded', fillsScanned: 0, ophisFound: 0, unresolved: 0, error: redactSecrets(err instanceof Error ? err.message : String(err)) },
        };
      }
    }),
  );
  const rawSwaps = settled.flatMap((r) => r.swaps);
  const swaps = await Promise.all(rawSwaps.map((s) => deps.enrich(s)));
  swaps.sort((a, b) => (a.tsUtc < b.tsUtc ? 1 : a.tsUtc > b.tsUtc ? -1 : 0));
  return { swaps, coverage: settled.map((r) => r.coverage) };
}
