import { avalanche, bnb, ChainInfo, ink, linea, plasma } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, BungeeBridgeProvider } from '@cowprotocol/sdk-bridging'

import { ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'

/**
 * sdk-bridging 4.0.2 hardcodes each provider's network list far below what the
 * provider APIs actually serve (verified against the live APIs, 2026-08-10):
 * Across covers every Ophis chain except Gnosis — including Robinhood Chain
 * (USDG routes) and Unichain — and Bungee's manual pipeline covers Unichain,
 * Ink and Linea. These subclasses widen ONLY the network list; quotes, token
 * lists and route availability still come live from the provider APIs, and
 * unroutable corridors stay disabled through the existing getBuyTokens probes.
 *
 * The widened list makes these chains bridge DESTINATIONS. Whether a chain can
 * be a bridge SOURCE is governed separately by BRIDGE_SOURCE_CHAIN_IDS
 * (common-const): sources need on-chain execution machinery these chains don't
 * have yet.
 */
const ACROSS_EXTRA_NETWORKS: ChainInfo[] = [
  avalanche,
  bnb,
  plasma,
  ink,
  linea,
  UNICHAIN_BRIDGE_CHAIN,
  ROBINHOOD_BRIDGE_CHAIN,
]

// Plasma and Robinhood Chain are deliberately absent: Bungee lists them as
// chains but serves zero routes on the manual pipeline this SDK consumes.
const BUNGEE_EXTRA_NETWORKS: ChainInfo[] = [ink, linea, UNICHAIN_BRIDGE_CHAIN]

export class OphisAcrossBridgeProvider extends AcrossBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return [...(await super.getNetworks()), ...ACROSS_EXTRA_NETWORKS]
  }
}

export class OphisBungeeBridgeProvider extends BungeeBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return [...(await super.getNetworks()), ...BUNGEE_EXTRA_NETWORKS]
  }
}
