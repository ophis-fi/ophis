import { avalanche, bnb, ChainInfo, ink, linea, plasma, SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  AcrossBridgeProvider,
  BungeeBridgeProvider,
  BuyTokensParams,
  GetProviderBuyTokens,
} from '@cowprotocol/sdk-bridging'

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

// Chains Across can actually EXECUTE a bridge deposit from with sdk-bridging
// 4.0.2: both ACROSS_SPOOK_CONTRACT_ADDRESSES and ACROSS_MATH_CONTRACT_ADDRESSES
// have entries only for these (getUnsignedBridgeCall throws on any other
// source). Deliberately narrower than the SDK's own 5-network source claim —
// Polygon/Optimism lack the math helper upstream and have always failed there;
// NEAR Intents covers every corridor that overlap loses.
const ACROSS_EXECUTABLE_SOURCE_IDS: ReadonlySet<number> = new Set<number>([
  SupportedChainId.MAINNET,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.BASE,
])

export class OphisAcrossBridgeProvider extends AcrossBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return [...(await super.getNetworks()), ...ACROSS_EXTRA_NETWORKS]
  }

  // Upstream getBuyTokens() reports availability from the DESTINATION token
  // list alone (sellChainId is ignored), so with the widened network list the
  // availability probe would light corridors Across cannot execute from —
  // e.g. Gnosis -> Robinhood Chain, where Across is the only provider serving
  // the destination but cannot bridge from the source, leaving an enabled
  // chain chip whose every quote fails. Gate availability on the executable
  // source set; other providers still contribute via the BridgingSdk union.
  async getBuyTokens(params: BuyTokensParams): Promise<GetProviderBuyTokens> {
    if (params.sellChainId !== undefined && !ACROSS_EXECUTABLE_SOURCE_IDS.has(params.sellChainId)) {
      return { tokens: [], isRouteAvailable: false }
    }

    return super.getBuyTokens(params)
  }
}

export class OphisBungeeBridgeProvider extends BungeeBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return [...(await super.getNetworks()), ...BUNGEE_EXTRA_NETWORKS]
  }
}
