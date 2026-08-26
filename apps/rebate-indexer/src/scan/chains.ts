import type { ChainConfig } from './types.js';

export const SCAN_CHAINS: readonly ChainConfig[] = [
  { chainId: 10,    name: 'optimism',  kind: 'local-db', dbContainer: 'optimism-mainnet-db-1' },
  { chainId: 1,     name: 'ethereum',  kind: 'rpc', alchemySubdomain: 'eth-mainnet',     defaultRpcUrl: 'https://eth.drpc.org' },
  { chainId: 100,   name: 'gnosis',    kind: 'rpc',                                  defaultRpcUrl: 'https://gnosis-rpc.publicnode.com' },
  { chainId: 8453,  name: 'base',      kind: 'rpc', alchemySubdomain: 'base-mainnet',    defaultRpcUrl: 'https://mainnet.base.org' },
  { chainId: 130,   name: 'unichain',  kind: 'rpc',                                  defaultRpcUrl: 'https://mainnet.unichain.org' },
  { chainId: 137,   name: 'polygon',   kind: 'rpc', alchemySubdomain: 'polygon-mainnet', defaultRpcUrl: 'https://polygon.drpc.org' },
  { chainId: 4663,  name: 'robinhood', kind: 'rpc',                                  defaultRpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
  {
    chainId: 56,
    name: 'bnb',
    kind: 'rpc',
    defaultRpcUrl: 'https://bsc.drpc.org',
    defaultBlockRpcUrl: 'https://bsc-dataseed.binance.org',
    scanLogChunk: 2_000,
    scanLogConcurrency: 1,
    scanClassifyConcurrency: 8,
  },
  { chainId: 42161, name: 'arbitrum',  kind: 'rpc', alchemySubdomain: 'arb-mainnet',     defaultRpcUrl: 'https://arb1.arbitrum.io/rpc' },
  { chainId: 43114, name: 'avalanche', kind: 'rpc', alchemySubdomain: 'avax-mainnet',    defaultRpcUrl: 'https://avalanche-c-chain-rpc.publicnode.com' },
  { chainId: 9745,  name: 'plasma',    kind: 'rpc',                                  defaultRpcUrl: 'https://rpc.plasma.to' },
  { chainId: 57073, name: 'ink',       kind: 'rpc',                                  defaultRpcUrl: 'https://rpc-qnd.inkonchain.com' },
  { chainId: 59144, name: 'linea',     kind: 'rpc',                                  defaultRpcUrl: 'https://rpc.linea.build' },
];

export function rpcEnvName(cfg: ChainConfig): string {
  return `SCAN_RPC_${cfg.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function blockRpcEnvName(cfg: ChainConfig): string {
  return `SCAN_BLOCK_RPC_${cfg.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function resolveRpcUrl(
  cfg: ChainConfig,
  apiKey = '',
  env: NodeJS.ProcessEnv = process.env,
): string {
  // ChainConfig is not a discriminated union, so kind:'rpc' does not statically
  // guarantee any URL source. Explicit per-chain RPC wins; an explicitly loaded
  // Alchemy key is next; public keyless RPC is the independent fallback.
  if (cfg.kind !== 'rpc') throw new Error(`chain ${cfg.name} is not an rpc chain`);
  const override = env[rpcEnvName(cfg)]?.trim();
  if (override) return override;
  if (apiKey && cfg.alchemySubdomain) return `https://${cfg.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`;
  if (cfg.defaultRpcUrl) return cfg.defaultRpcUrl;
  throw new Error(`rpc chain ${cfg.name} has no URL; set ${rpcEnvName(cfg)}`);
}

/** Resolve the client used for block-number/timestamp lookups. A full
 * SCAN_RPC override is assumed to support both operations unless the operator
 * supplies the more specific SCAN_BLOCK_RPC override. */
export function resolveBlockRpcUrl(
  cfg: ChainConfig,
  apiKey = '',
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (cfg.kind !== 'rpc') throw new Error(`chain ${cfg.name} is not an rpc chain`);
  const blockOverride = env[blockRpcEnvName(cfg)]?.trim();
  if (blockOverride) return blockOverride;
  const rpcOverride = env[rpcEnvName(cfg)]?.trim();
  if (rpcOverride) return rpcOverride;
  if (apiKey && cfg.alchemySubdomain) return `https://${cfg.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`;
  return cfg.defaultBlockRpcUrl ?? resolveRpcUrl(cfg, apiKey, env);
}

export function selectChains(names?: string[]): ChainConfig[] {
  if (!names || names.length === 0) return [...SCAN_CHAINS];
  return names.map((n) => {
    const cfg = SCAN_CHAINS.find((c) => c.name === n.trim().toLowerCase());
    if (!cfg) throw new Error(`unknown chain '${n}'; known: ${SCAN_CHAINS.map((c) => c.name).join(', ')}`);
    return cfg;
  });
}
