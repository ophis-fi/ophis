import { HttpsString, TargetChainId } from '@cowprotocol/cow-sdk'

import { MONAD_CHAIN_ID, MONAD_LOGO, XLAYER_CHAIN_ID, XLAYER_LOGO } from './bridgeDestinationConst'
import { NATIVE_CURRENCIES } from './nativeAndWrappedTokens'

import type { BaseChainInfo } from './chainInfo'

export { MONAD_CHAIN_ID, XLAYER_CHAIN_ID } from './bridgeDestinationConst'

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
}
