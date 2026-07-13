import { defineChain, type Chain } from 'viem';
import {
  mainnet,
  optimism,
  bsc,
  gnosis,
  polygon,
  base,
  arbitrum,
  avalanche,
  linea,
} from 'viem/chains';

// Unichain (130) and Ink (57073) are defined inline so this plugin does not depend
// on the installed viem version shipping them in its chain catalog. Unichain is the
// Ophis-sovereign chain (MEV-protected, few agents route here) — the differentiator.
const unichain = defineChain({
  id: 130,
  name: 'Unichain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } },
});
const ink = defineChain({
  id: 57073,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-gel.inkonchain.com'] } },
});

export interface OphisChain {
  id: number;
  chain: Chain;
  /** UPPERCASE token used to look up an RPC override setting: ETHEREUM_PROVIDER_<KEY>. */
  settingKey: string;
}

// Every Ophis-supported mainnet chain that has a working viem chain object. Aliases
// (op/bnb/xdai/matic/arb/avax) map to the same entry so natural-language chain names
// resolve. Plasma (9745) is intentionally omitted until there is agent demand.
export const OPHIS_CHAINS: Record<string, OphisChain> = {
  ethereum: { id: 1, chain: mainnet, settingKey: 'ETHEREUM' },
  mainnet: { id: 1, chain: mainnet, settingKey: 'ETHEREUM' },
  optimism: { id: 10, chain: optimism, settingKey: 'OPTIMISM' },
  op: { id: 10, chain: optimism, settingKey: 'OPTIMISM' },
  bnb: { id: 56, chain: bsc, settingKey: 'BNB' },
  bsc: { id: 56, chain: bsc, settingKey: 'BNB' },
  gnosis: { id: 100, chain: gnosis, settingKey: 'GNOSIS' },
  xdai: { id: 100, chain: gnosis, settingKey: 'GNOSIS' },
  unichain: { id: 130, chain: unichain, settingKey: 'UNICHAIN' },
  polygon: { id: 137, chain: polygon, settingKey: 'POLYGON' },
  matic: { id: 137, chain: polygon, settingKey: 'POLYGON' },
  base: { id: 8453, chain: base, settingKey: 'BASE' },
  ink: { id: 57073, chain: ink, settingKey: 'INK' },
  arbitrum: { id: 42161, chain: arbitrum, settingKey: 'ARBITRUM' },
  arb: { id: 42161, chain: arbitrum, settingKey: 'ARBITRUM' },
  avalanche: { id: 43114, chain: avalanche, settingKey: 'AVALANCHE' },
  avax: { id: 43114, chain: avalanche, settingKey: 'AVALANCHE' },
  linea: { id: 59144, chain: linea, settingKey: 'LINEA' },
};

/** Canonical chain names (deduped by id) for the LLM template + error messages. */
export const SUPPORTED_CHAIN_NAMES = [
  'ethereum',
  'optimism',
  'bnb',
  'gnosis',
  'unichain',
  'polygon',
  'base',
  'ink',
  'arbitrum',
  'avalanche',
  'linea',
];

export function resolveChain(name: string): OphisChain | undefined {
  return OPHIS_CHAINS[name.trim().toLowerCase()];
}
