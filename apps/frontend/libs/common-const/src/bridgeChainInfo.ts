import { EvmChainInfo, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'

import { getChainInfo } from './chainInfo'
import { RPC_URLS } from './networks'

// Canonical Multicall3 (https://www.multicall3.com), verified deployed at this
// address on Unichain and Robinhood Chain via eth_getCode (2026-08-10); Monad
// and X Layer are NEAR destinations only, nothing multicalls them from here.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * SDK-shaped ChainInfo for the chains the upstream sdk-config does not know
 * (Unichain 130, Robinhood Chain 4663, and the NEAR-only destinations Monad
 * 143 / X Layer 196), so they can appear in bridge provider network lists.
 * Cosmetics come from the app's own chain infos (getChainInfo, which also
 * covers BRIDGE_DESTINATION_CHAIN_INFO): one source of truth for labels,
 * logos, explorers and native currencies.
 */
export function toBridgeChainInfo(chainId: number): EvmChainInfo {
  const info = getChainInfo(chainId as TargetChainId)
  const native = info.nativeCurrency

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
    nativeCurrency: {
      chainId,
      address: native.address,
      name: native.name ?? native.symbol ?? '',
      symbol: native.symbol ?? '',
      decimals: native.decimals,
      logoUrl: native.logoURI,
    },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    rpcUrls: { default: { http: [RPC_URLS[chainId as unknown as SupportedChainId]] } },
  }
}
