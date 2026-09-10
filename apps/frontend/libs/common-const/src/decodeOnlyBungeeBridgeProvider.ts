import { ChainInfo } from '@cowprotocol/cow-sdk'
import { BungeeBridgeProvider, BuyTokensParams, GetProviderBuyTokens } from '@cowprotocol/sdk-bridging'

/**
 * Bungee, DECODE-ONLY. Shared by the swap app and the explorer so the two can
 * never drift.
 *
 * Bungee's manual v1 API (the only one sdk-bridging 4.0.2 speaks) has answered
 * 410 Gone on every route since August 2026, so it can never quote again. It
 * stays registered because the SDK resolves an existing order's provider by the
 * dappId in its appData hooks (getProviderFromAppData / getOrder), and both
 * search the AVAILABLE provider list: dropping Bungee would break rendering of
 * every historical Bungee order. Advertising no networks keeps it out of the
 * quote fan-out (fetchMultiQuote gates on getNetworks) and the destination
 * picker; getBuyTokens is overridden too because that fan-out has no network
 * gate and would otherwise fire one 410 per destination chain on every
 * token-picker open. Status reads for historical orders (Socket's events API,
 * and app.across.to for Across-routed ones) are the only traffic left.
 */
export class DecodeOnlyBungeeBridgeProvider extends BungeeBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return []
  }

  async getBuyTokens(_params: BuyTokensParams): Promise<GetProviderBuyTokens> {
    return { tokens: [], isRouteAvailable: false }
  }
}

/**
 * The one way to construct it. No API base, dedicated-proxy routing or
 * affiliate header: nothing can reach Bungee's quote API any more.
 * `includeBridges` stays because BungeeApi.validateBridges throws at
 * construction on other slugs.
 */
export function createDecodeOnlyBungeeBridgeProvider(): DecodeOnlyBungeeBridgeProvider {
  return new DecodeOnlyBungeeBridgeProvider({
    apiOptions: { includeBridges: ['across', 'cctp', 'gnosis-native-bridge'] },
  })
}
