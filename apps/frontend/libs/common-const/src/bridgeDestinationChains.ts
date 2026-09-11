import { HttpsString, TargetChainId } from '@cowprotocol/cow-sdk'

import {
  HYPERCORE_CHAIN_ID,
  HYPERLIQUID_LOGO,
  MONAD_CHAIN_ID,
  MONAD_LOGO,
  SUI_CHAIN_ID,
  SUI_LOGO,
  TRON_CHAIN_ID,
  TRON_LOGO,
  XLAYER_CHAIN_ID,
  XLAYER_LOGO,
} from './bridgeDestination.const'
import { NATIVE_CURRENCIES } from './nativeAndWrappedTokens'

import type { BaseChainInfo } from './chainInfo'

export {
  HYPERCORE_CHAIN_ID,
  MONAD_CHAIN_ID,
  SUI_CHAIN_ID,
  TRON_CHAIN_ID,
  XLAYER_CHAIN_ID,
} from './bridgeDestination.const'

/**
 * Chains Ophis offers ONLY as bridge destinations (via NEAR Intents): no
 * orderbook, no trading, so they stay out of CHAIN_INFO (which drives the
 * explorer's network routes and the "available chains" copy) and live here.
 * getChainInfo() falls back to this map so network badges, the "Receive on"
 * picker and the bridge chain infos all resolve them. They ARE listed in
 * SORTED_DST_CHAIN_IDS (destination order) and NATIVE_CURRENCIES (native
 * semantics), the two shared lists the destination picker reads.
 */
export const BRIDGE_DESTINATION_CHAIN_INFO: Readonly<Partial<Record<number, BaseChainInfo>>> = {
  [MONAD_CHAIN_ID]: {
    docs: 'https://docs.monad.xyz' as HttpsString,
    explorer: 'https://monadscan.com' as HttpsString,
    infoLink: 'https://www.monad.xyz' as HttpsString,
    logo: { light: MONAD_LOGO, dark: MONAD_LOGO },
    addressPrefix: 'monad',
    label: 'Monad',
    eip155Label: 'Monad',
    explorerTitle: 'MonadScan',
    color: '#836EF9',
    name: 'monad',
    urlAlias: 'monad',
    // From NATIVE_CURRENCIES so getIsNativeToken() recognises the sentinel.
    nativeCurrency: NATIVE_CURRENCIES[MONAD_CHAIN_ID as TargetChainId],
  },
  [XLAYER_CHAIN_ID]: {
    docs: 'https://web3.okx.com/xlayer/docs' as HttpsString,
    explorer: 'https://www.oklink.com/xlayer' as HttpsString,
    infoLink: 'https://www.okx.com/xlayer' as HttpsString,
    logo: { light: XLAYER_LOGO, dark: XLAYER_LOGO },
    addressPrefix: 'xlayer',
    label: 'X Layer',
    eip155Label: 'X Layer',
    explorerTitle: 'OKLink',
    color: '#000000',
    name: 'xlayer',
    urlAlias: 'xlayer',
    nativeCurrency: NATIVE_CURRENCIES[XLAYER_CHAIN_ID as TargetChainId],
  },
  // Non-EVM destinations (address rules in nonEvmDestinations.ts).
  [SUI_CHAIN_ID]: {
    docs: 'https://docs.sui.io' as HttpsString,
    explorer: 'https://suiscan.xyz/mainnet' as HttpsString,
    addressPath: 'account',
    tokenPath: 'coin',
    infoLink: 'https://sui.io' as HttpsString,
    logo: { light: SUI_LOGO, dark: SUI_LOGO },
    addressPrefix: 'sui',
    label: 'Sui',
    eip155Label: 'Sui',
    explorerTitle: 'Suiscan',
    color: '#4DA2FF',
    name: 'sui',
    urlAlias: 'sui',
    nativeCurrency: NATIVE_CURRENCIES[SUI_CHAIN_ID as TargetChainId],
  },
  [TRON_CHAIN_ID]: {
    docs: 'https://developers.tron.network' as HttpsString,
    explorer: 'https://tronscan.org/#' as HttpsString,
    tokenPath: 'token20',
    infoLink: 'https://tron.network' as HttpsString,
    logo: { light: TRON_LOGO, dark: TRON_LOGO },
    addressPrefix: 'tron',
    label: 'Tron',
    eip155Label: 'Tron',
    explorerTitle: 'Tronscan',
    color: '#FF060A',
    name: 'tron',
    urlAlias: 'tron',
    nativeCurrency: NATIVE_CURRENCIES[TRON_CHAIN_ID as TargetChainId],
  },
  [HYPERCORE_CHAIN_ID]: {
    docs: 'https://hyperliquid.gitbook.io/hyperliquid-docs' as HttpsString,
    explorer: 'https://app.hyperliquid.xyz/explorer' as HttpsString,
    tokenPath: 'token',
    infoLink: 'https://hyperliquid.xyz' as HttpsString,
    logo: { light: HYPERLIQUID_LOGO, dark: HYPERLIQUID_LOGO },
    addressPrefix: 'hl',
    label: 'Hyperliquid',
    eip155Label: 'Hyperliquid',
    explorerTitle: 'Hyperliquid Explorer',
    color: '#97FCE4',
    name: 'hyperliquid',
    urlAlias: 'hyperliquid',
    nativeCurrency: NATIVE_CURRENCIES[HYPERCORE_CHAIN_ID as TargetChainId],
  },
}

/** Display names of the bridge-only destinations, for public copy that lists them. */
export const BRIDGE_ONLY_DESTINATION_LABELS: readonly string[] = Object.values(BRIDGE_DESTINATION_CHAIN_INFO).flatMap(
  (info) => (info ? [info.label] : []),
)

/** The labels as prose: "A, B and C". */
export const BRIDGE_ONLY_DESTINATION_LABELS_TEXT: string =
  BRIDGE_ONLY_DESTINATION_LABELS.length > 1
    ? `${BRIDGE_ONLY_DESTINATION_LABELS.slice(0, -1).join(', ')} and ${BRIDGE_ONLY_DESTINATION_LABELS[BRIDGE_ONLY_DESTINATION_LABELS.length - 1]}`
    : (BRIDGE_ONLY_DESTINATION_LABELS[0] ?? '')

/** True for a chain Ophis serves only as a bridge destination (Monad, X Layer, Sui, Tron, Hyperliquid). */
export function isBridgeOnlyDestinationChain(chainId: number | undefined): boolean {
  return chainId !== undefined && chainId in BRIDGE_DESTINATION_CHAIN_INFO
}
