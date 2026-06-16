import {
  AdditionalTargetChainId,
  arbitrumOne,
  avalanche,
  base,
  bitcoin,
  bnb,
  ChainInfo,
  gnosisChain,
  HttpsString,
  ink,
  isEvmChainInfo,
  linea,
  mainnet,
  optimism,
  plasma,
  polygon,
  sepolia,
  solana,
  SupportedChainId,
  TargetChainId,
} from '@cowprotocol/cow-sdk'

import { NATIVE_CURRENCIES } from './nativeAndWrappedTokens'
import { TokenWithLogo } from './types'

// Ophis fork (2026-05-20): MegaETH (4326) chain definition removed from the
// frontend. Backend scaffolding is preserved in `infra/megaeth-mainnet/` for
// future re-enablement. Removed from the chain selectors, orderbook routing,
// and RPC maps so users can't pick a chain we don't actively operate.
// HyperEVM (999) was re-enabled 2026-06-17 (see HYPEREVM_CHAIN_ID below).

// Ophis fork: HyperEVM mainnet (chain 999) added at frontend layer. SDK does
// not ship a ChainInfo. The native token on HyperEVM is HYPE (18 decimals).
// The chain is commonly labeled "Hyperliquid" externally (CoinGecko, DefiLlama,
// Debank), even though the EVM layer is called HyperEVM. Settlement and
// VaultRelayer addresses are configured separately in cowProtocolContracts.ts.
const HYPEREVM_CHAIN_ID = 999 as unknown as SupportedChainId

export interface BaseChainInfo {
  readonly docs: HttpsString
  readonly bridge?: HttpsString
  readonly explorer: HttpsString
  readonly infoLink: HttpsString
  readonly logo: { light: HttpsString; dark: HttpsString }
  readonly name: string
  readonly addressPrefix: string
  readonly label: string
  readonly eip155Label?: string
  readonly urlAlias: string
  readonly helpCenterUrl?: string
  readonly explorerTitle: string
  readonly color: string
  readonly nativeCurrency: TokenWithLogo
}

export type ChainInfoMap = Record<TargetChainId, BaseChainInfo>

function mapChainInfoToBaseChainInfo(
  chainInfo: ChainInfo,
): Pick<
  BaseChainInfo,
  'docs' | 'bridge' | 'explorer' | 'infoLink' | 'logo' | 'addressPrefix' | 'label' | 'explorerTitle' | 'color'
> & { eip155Label?: string } {
  return {
    docs: chainInfo.docs.url,
    bridge: chainInfo.bridges?.[0]?.url,
    explorer: chainInfo.blockExplorer.url ?? '',
    infoLink: chainInfo.website.url,
    logo: {
      light: chainInfo.logo.light as HttpsString,
      dark: chainInfo.logo.dark as HttpsString,
    },
    addressPrefix: chainInfo.addressPrefix,
    label: chainInfo.label,
    explorerTitle: chainInfo.blockExplorer.name,
    color: chainInfo.color,
    eip155Label: isEvmChainInfo(chainInfo) ? chainInfo.eip155Label : undefined,
  }
}

/**
 * Map with chain information for supported networks.
 * Ordered by relevance, first is most relevant.
 * Keep in mind when iterating over this map that the order of keys is guaranteed to be numerically sorted.
 * So this order is mostly for reference and not for iteration.
 */
export const CHAIN_INFO: ChainInfoMap = {
  [SupportedChainId.MAINNET]: {
    ...mapChainInfoToBaseChainInfo(mainnet),
    name: 'ethereum',
    urlAlias: '',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.MAINNET],
  },
  [SupportedChainId.BNB]: {
    ...mapChainInfoToBaseChainInfo(bnb),
    name: 'bnb',
    urlAlias: 'bnb',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.BNB],
  },
  [SupportedChainId.BASE]: {
    ...mapChainInfoToBaseChainInfo(base),
    name: 'base',
    urlAlias: 'base',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.BASE],
  },
  [SupportedChainId.ARBITRUM_ONE]: {
    ...mapChainInfoToBaseChainInfo(arbitrumOne),
    name: 'arbitrum_one',
    urlAlias: 'arb1',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.ARBITRUM_ONE],
  },
  [SupportedChainId.POLYGON]: {
    ...mapChainInfoToBaseChainInfo(polygon),
    name: 'polygon',
    urlAlias: 'pol',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.POLYGON],
  },
  [SupportedChainId.AVALANCHE]: {
    ...mapChainInfoToBaseChainInfo(avalanche),
    name: 'avalanche',
    urlAlias: 'avax',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.AVALANCHE],
  },
  [SupportedChainId.GNOSIS_CHAIN]: {
    ...mapChainInfoToBaseChainInfo(gnosisChain),
    name: 'gnosis_chain',
    urlAlias: 'gc',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.GNOSIS_CHAIN],
  },
  [SupportedChainId.LINEA]: {
    ...mapChainInfoToBaseChainInfo(linea),
    name: 'linea',
    urlAlias: 'linea',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.LINEA],
  },
  [SupportedChainId.PLASMA]: {
    ...mapChainInfoToBaseChainInfo(plasma),
    name: 'plasma',
    urlAlias: 'plasma',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.PLASMA],
  },
  [SupportedChainId.INK]: {
    ...mapChainInfoToBaseChainInfo(ink),
    name: 'ink',
    urlAlias: 'ink',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.INK],
  },
  [SupportedChainId.SEPOLIA]: {
    ...mapChainInfoToBaseChainInfo(sepolia),
    name: 'sepolia',
    urlAlias: 'sepolia',
    nativeCurrency: NATIVE_CURRENCIES[SupportedChainId.SEPOLIA],
  },
  [AdditionalTargetChainId.SOLANA]: {
    ...mapChainInfoToBaseChainInfo(solana),
    name: 'solana',
    urlAlias: 'solana',
    nativeCurrency: NATIVE_CURRENCIES[AdditionalTargetChainId.SOLANA],
  },
  [AdditionalTargetChainId.BITCOIN]: {
    ...mapChainInfoToBaseChainInfo(bitcoin),
    name: 'bitcoin',
    urlAlias: 'bitcoin',
    nativeCurrency: NATIVE_CURRENCIES[AdditionalTargetChainId.BITCOIN],
  },
  [AdditionalTargetChainId.OPTIMISM]: {
    ...mapChainInfoToBaseChainInfo(optimism),
    name: 'optimism',
    urlAlias: 'opt',
    nativeCurrency: NATIVE_CURRENCIES[AdditionalTargetChainId.OPTIMISM],
  },
  // Ophis fork: HyperEVM mainnet (chain 999). Hand-rolled because the SDK
  // does not (yet) ship a ChainInfo for HyperEVM. Industry-standard label is
  // "Hyperliquid" — DefiLlama / CoinGecko / Debank all use that name even
  // though the EVM layer is technically HyperEVM.
  [HYPEREVM_CHAIN_ID]: {
    docs: 'https://hyperliquid.gitbook.io/hyperliquid-docs' as HttpsString,
    explorer: 'https://hyperevmscan.io' as HttpsString,
    infoLink: 'https://hyperliquid.xyz' as HttpsString,
    logo: {
      light: 'https://app.hyperliquid.xyz/coins/HYPE_USDC.svg' as HttpsString,
      dark: 'https://app.hyperliquid.xyz/coins/HYPE_USDC.svg' as HttpsString,
    },
    name: 'hyperevm',
    addressPrefix: 'hl',
    label: 'Hyperliquid',
    eip155Label: 'Hyperliquid',
    urlAlias: 'hl',
    explorerTitle: 'HyperEVMScan',
    color: '#97FBE4',
    nativeCurrency: NATIVE_CURRENCIES[HYPEREVM_CHAIN_ID],
  },
  // MegaETH (4326) intentionally not in CHAIN_INFO —
  // see top-of-file comment for context (removed 2026-05-20).
}

/**
 * Sorted array of chain IDs in order of relevance.
 * TODO: Sort by TVL? Reference: https://defillama.com/chain/gnosis
 */
export const SORTED_CHAIN_IDS: SupportedChainId[] = [
  SupportedChainId.MAINNET,
  SupportedChainId.BNB,
  SupportedChainId.BASE,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.POLYGON,
  SupportedChainId.AVALANCHE,
  SupportedChainId.LINEA, // TODO: decide where to place Linea
  SupportedChainId.PLASMA, // TODO: decide where to place Plasma
  SupportedChainId.INK, // TODO: decide where to place Ink
  SupportedChainId.GNOSIS_CHAIN,
  AdditionalTargetChainId.OPTIMISM as unknown as SupportedChainId,
  // Ophis fork: HyperEVM mainnet (chain 999)
  HYPEREVM_CHAIN_ID,
  SupportedChainId.SEPOLIA,
]

/**
 * Sorted array of chain IDs in order of relevance.
 * TODO: Sort by TVL? Reference: https://defillama.com/chain/gnosis
 */
export const SORTED_DST_CHAIN_IDS: TargetChainId[] = [
  SupportedChainId.MAINNET,
  SupportedChainId.BNB,
  SupportedChainId.BASE,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.POLYGON,
  SupportedChainId.AVALANCHE,
  SupportedChainId.LINEA, // TODO: decide where to place Linea
  SupportedChainId.PLASMA, // TODO: decide where to place Plasma
  SupportedChainId.INK, // TODO: decide where to place Ink
  SupportedChainId.GNOSIS_CHAIN,
  AdditionalTargetChainId.OPTIMISM,
  // Ophis fork: HyperEVM mainnet (chain 999)
  HYPEREVM_CHAIN_ID as unknown as TargetChainId,
  AdditionalTargetChainId.SOLANA,
  AdditionalTargetChainId.BITCOIN,
  SupportedChainId.SEPOLIA,
]

export const CHAIN_INFO_ARRAY: BaseChainInfo[] = SORTED_CHAIN_IDS.map((id) => CHAIN_INFO[id])

export function getChainInfo(chainId: TargetChainId): BaseChainInfo {
  return CHAIN_INFO[chainId]
}
