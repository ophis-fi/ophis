import { createPublicClient, http } from 'viem';
import { redactSecrets } from './redact.js';
import { selectChains, resolveRpcUrl } from './chains.js';
import { parseSince } from './window.js';
import { loadCache } from './cache.js';
import { loadAlchemyEnv, loadTelegramEnv } from './secrets.js';
import { getOrder } from '../cow/client.js';
import { scanHostedChain, type LogClient } from './sources/onchain.js';
import { scanLocalDbChain } from './sources/localDb.js';
import { enrichSwap, type Erc20Reader } from './enrich.js';
import { runScan } from './run.js';
import { renderTable, telegramSummary, defaultJsonPath, writeJsonArtifact } from './report.js';
import type { ChainConfig, ScanResult, Swap } from './types.js';

function arg(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm scan --since <48h|2d|90m> [--chains a,b] [--telegram] [--json <path>]');
    return;
  }

  const sinceSec = parseSince(arg(args, 'since') ?? '48h');
  const chains = selectChains(arg(args, 'chains')?.split(','));
  const wantTelegram = args.includes('--telegram');
  const nowSec = Math.floor(Date.now() / 1000);
  const t0Sec = nowSec - sinceSec;
  const t0Iso = new Date(t0Sec * 1000).toISOString();

  const cache = await loadCache();
  const metaCache = new Map<string, { symbol: string | null; decimals: number | null }>();
  const refPriceCache = new Map<number, number>();

  // Only fetch the Alchemy key if at least one rpc chain is selected.
  const needsRpc = chains.some((c) => c.kind === 'rpc');
  const alchemyKey = needsRpc ? await loadAlchemyEnv() : '';
  const clients = new Map<number, ReturnType<typeof createPublicClient>>();
  const clientFor = (cfg: ChainConfig) => {
    let c = clients.get(cfg.chainId);
    if (!c) { c = createPublicClient({ transport: http(resolveRpcUrl(cfg, alchemyKey)) }); clients.set(cfg.chainId, c); }
    return c;
  };

  const scanChain = (cfg: ChainConfig): Promise<ScanResult> => {
    if (cfg.kind === 'local-db') return scanLocalDbChain(cfg, t0Iso);
    const client = clientFor(cfg) as unknown as LogClient;
    return scanHostedChain(cfg, t0Sec, { client, getOrder, cache });
  };

  const enrich = (swap: Swap): Promise<Swap> => {
    const cfg = chains.find((c) => c.chainId === swap.chainId);
    const reader = (cfg && cfg.kind === 'rpc') ? (clientFor(cfg) as unknown as Erc20Reader) : null;
    return enrichSwap(swap, { reader, metaCache, refPriceCache });
  };

  const { swaps, coverage } = await runScan({ sinceSec, chains, nowSec }, { scanChain, enrich });
  await cache.save();

  const windowLabel = `last ${arg(args, 'since') ?? '48h'}`;
  console.log(renderTable(swaps, coverage));

  const jsonPath = arg(args, 'json') ?? defaultJsonPath(new Date(nowSec * 1000).toISOString());
  await writeJsonArtifact(jsonPath, { window: windowLabel, generatedAt: new Date(nowSec * 1000).toISOString(), swaps, coverage });
  console.log(`\nJSON: ${jsonPath}`);

  if (wantTelegram) {
    if (await loadTelegramEnv()) {
      // Import alerter AFTER loadTelegramEnv() populates process.env. alerter.ts
      // snapshots TOKEN/CHAT_ID at MODULE LOAD, so a static top-of-file import would
      // capture them as undefined (they are set at runtime) and notify() would
      // silently no-op. A dynamic import here loads the module post-env.
      const { notify } = await import('../telegram/alerter.js');
      await notify(telegramSummary(swaps, coverage, windowLabel));
      console.log('Telegram: sent');
    } else {
      console.log('Telegram: skipped (no token in keychain/env)');
    }
  }
}

main().catch((err) => {
  // Defense-in-depth: a stray viem error here would embed the Alchemy key in its URL.
  console.error(redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
