import type { ChainConfig } from './types.js';

export const SCAN_CHAINS: readonly ChainConfig[] = [
  { chainId: 10,    name: 'optimism',  kind: 'local-db', dbContainer: 'optimism-mainnet-db-1' },
  { chainId: 1,     name: 'ethereum',  kind: 'rpc', alchemySubdomain: 'eth-mainnet' },
  { chainId: 8453,  name: 'base',      kind: 'rpc', alchemySubdomain: 'base-mainnet' },
  { chainId: 42161, name: 'arbitrum',  kind: 'rpc', alchemySubdomain: 'arb-mainnet' },
  { chainId: 137,   name: 'polygon',   kind: 'rpc', alchemySubdomain: 'polygon-mainnet' },
  { chainId: 43114, name: 'avalanche', kind: 'rpc', alchemySubdomain: 'avax-mainnet' },
];

export function resolveRpcUrl(cfg: ChainConfig, apiKey: string): string {
  if (cfg.kind !== 'rpc' || !cfg.alchemySubdomain) {
    throw new Error(`chain ${cfg.name} is not an rpc chain`);
  }
  if (!apiKey) throw new Error('alchemy api key is empty');
  return `https://${cfg.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`;
}

export function selectChains(names?: string[]): ChainConfig[] {
  if (!names || names.length === 0) return [...SCAN_CHAINS];
  return names.map((n) => {
    const cfg = SCAN_CHAINS.find((c) => c.name === n.trim().toLowerCase());
    if (!cfg) throw new Error(`unknown chain '${n}'; known: ${SCAN_CHAINS.map((c) => c.name).join(', ')}`);
    return cfg;
  });
}
