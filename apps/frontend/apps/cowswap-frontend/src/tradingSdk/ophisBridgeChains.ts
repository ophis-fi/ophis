import { CHAIN_INFO, RPC_URLS } from '@cowprotocol/common-const'
import { EvmChainInfo, nativeCurrencyTemplate, SupportedChainId } from '@cowprotocol/cow-sdk'

// Canonical Multicall3 (https://www.multicall3.com), verified deployed at this
// address on both Unichain and Robinhood Chain via eth_getCode (2026-08-10).
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * SDK-shaped ChainInfo for the Ophis-only chains the upstream sdk-config does
 * not know (Unichain 130, Robinhood Chain 4663), so they can appear in bridge
 * provider network lists. Cosmetics come from the app's own CHAIN_INFO —
 * single source of truth for labels/logos/explorers.
 */
function toBridgeChainInfo(chainId: number): EvmChainInfo {
  const info = CHAIN_INFO[chainId as unknown as SupportedChainId]

  return {
    id: chainId,
    label: info.label,
    eip155Label: info.eip155Label ?? info.label,
    addressPrefix: info.addressPrefix,
    isTestnet: false,
    color: info.color,
    logo: { light: info.logo.light, dark: info.logo.dark },
    docs: { url: info.docs, name: `${info.label} Docs` },
    website: { url: info.infoLink, name: info.label },
    blockExplorer: { url: info.explorer, name: info.explorerTitle },
    // Both chains use plain ETH as the native currency.
    nativeCurrency: { ...nativeCurrencyTemplate, chainId },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    rpcUrls: { default: { http: [RPC_URLS[chainId as unknown as SupportedChainId]] } },
  }
}

export const UNICHAIN_BRIDGE_CHAIN: EvmChainInfo = toBridgeChainInfo(130)
export const ROBINHOOD_BRIDGE_CHAIN: EvmChainInfo = toBridgeChainInfo(4663)
