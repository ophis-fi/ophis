import { ARC_CHAIN_ID, toBridgeChainInfo } from '@cowprotocol/common-const'
import { EvmChainInfo, mainnet } from '@cowprotocol/cow-sdk'

// toBridgeChainInfo moved to common-const (shared with the explorer and the
// NEAR destination registration); re-exported so existing imports keep working.
export { toBridgeChainInfo }
export const ROBINHOOD_BRIDGE_CHAIN: EvmChainInfo = toBridgeChainInfo(4663)

export const ARC_BRIDGE_CHAIN: EvmChainInfo = toBridgeChainInfo(ARC_CHAIN_ID)

// Receipt metadata only; never register this retired chain with a quote provider.
export const RETIRED_UNICHAIN_BRIDGE_CHAIN: EvmChainInfo = {
  id: 130,
  label: 'Unichain',
  eip155Label: 'Unichain',
  addressPrefix: 'uni',
  isTestnet: false,
  isDeprecated: true,
  color: '#FF007A',
  logo: {
    light: 'https://swap.ophis.fi/logos/chain-unichain.svg',
    dark: 'https://swap.ophis.fi/logos/chain-unichain.svg',
  },
  docs: { url: 'https://docs.unichain.org', name: 'Unichain Docs' },
  website: { url: 'https://www.unichain.org', name: 'Unichain' },
  blockExplorer: { url: 'https://uniscan.xyz', name: 'Uniscan' },
  nativeCurrency: { ...mainnet.nativeCurrency, chainId: 130 },
  contracts: {},
  rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } },
}
