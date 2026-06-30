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

// Official Unichain brand mark (pink #F50DB4 web3icons glyph, MIT) inlined as a
// data: URI. CHAIN_INFO lives in this shared lib and is consumed by multiple
// apps (cowswap-frontend, explorer, ...); inlining keeps the logo
// origin-independent so no app 404s on a missing /logos asset. See the chain
// 130 entry below. Consumed via <img src> (CSP img-src allows data:).
const UNICHAIN_LOGO_DATA_URI =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiIGZpbGw9Im5vbmUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEyIiBmaWxsPSIjRjUwREI0Ii8+PHBhdGggdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTIgMTIpIHNjYWxlKC43NCkgdHJhbnNsYXRlKC0xMiAtMTIpIiBmaWxsPSIjZmZmIiBkPSJNMjEgMTEuODI5QTguODMgOC44MyAwIDAgMSAxMi4xNzEgM2gtLjM0MnY4LjgyOUgzdi4zNDJBOC44MyA4LjgzIDAgMCAxIDExLjgyOSAyMWguMzQydi04LjgyOUgyMXoiLz48L3N2Zz4=' as HttpsString

// Ophis fork (2026-05-20): MegaETH (4326) and HyperEVM (999) chain
// definitions removed from the frontend. Backend scaffolding for these
// chains is preserved in `infra/megaeth-mainnet/` + `infra/hyperevm-mainnet/`
// for future re-enablement. Removing them from the chain selectors,
// orderbook routing, and RPC maps so users can't pick a chain we don't
// actively operate.

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
  // Ophis fork: Unichain (chain 130). Not in the SDK's TargetChainId /
  // AdditionalTargetChainId enums, so the BaseChainInfo is constructed
  // literally here (mirrors the shape `mapChainInfoToBaseChainInfo` produces
  // for the SDK chains). Unichain is an OP-Stack rollup; the logo is the
  // official Unichain brand mark (pink #F50DB4 web3icons glyph, MIT) inlined
  // as a data: URI. CHAIN_INFO is in the SHARED common-const lib, consumed by
  // cowswap-frontend AND explorer (+ future apps); a root-relative /logos path
  // would resolve against each app's own origin and 404 where the asset isn't
  // shipped, so the logo travels WITH the constant. Like the SDK chains' logos
  // it is origin-independent. CSP img-src allows data:. Previously reused the
  // SDK ethereum logo as a placeholder, which rendered the Ethereum diamond.
  [130 as unknown as SupportedChainId]: {
    docs: 'https://docs.unichain.org' as HttpsString,
    explorer: 'https://uniscan.xyz' as HttpsString,
    infoLink: 'https://www.unichain.org' as HttpsString,
    logo: {
      light: UNICHAIN_LOGO_DATA_URI,
      dark: UNICHAIN_LOGO_DATA_URI,
    },
    addressPrefix: 'uni',
    label: 'Unichain',
    eip155Label: 'Unichain',
    explorerTitle: 'Uniscan',
    color: '#FF007A',
    name: 'unichain',
    urlAlias: 'unichain',
    nativeCurrency: NATIVE_CURRENCIES[130 as unknown as SupportedChainId],
  },
  // MegaETH (4326) + HyperEVM (999) intentionally not in CHAIN_INFO —
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
  130 as unknown as SupportedChainId, // Ophis fork: Unichain
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
  130 as unknown as TargetChainId, // Ophis fork: Unichain
  AdditionalTargetChainId.SOLANA,
  AdditionalTargetChainId.BITCOIN,
  SupportedChainId.SEPOLIA,
]

export const CHAIN_INFO_ARRAY: BaseChainInfo[] = SORTED_CHAIN_IDS.map((id) => CHAIN_INFO[id])

export function getChainInfo(chainId: TargetChainId): BaseChainInfo {
  return CHAIN_INFO[chainId]
}
