import { WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web'
import { POI_REQUIRED_LISTS, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { CONFIG, FEE_SIGNER, TOKENS } from '../src/config'

// Read-only discovery only; this file is never imported by the application build.
export async function startReadOnlyDiscovery(): Promise<void> {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) throw new Error('Local test origin required.')
  await WakuBroadcasterClient.start(CONFIG.chain, {
    trustedFeeSigner: FEE_SIGNER,
    poiActiveListKeys: POI_REQUIRED_LISTS.map((list) => list.key),
    enableHealthcheckLogs: false,
  }, () => {})
}

export function readOnlyFees(): Record<string, number> {
  return Object.fromEntries(Object.values(TOKENS).map((token) => [token.symbol, readOnlyFeeCount(token.address)]))
}

export function readOnlyFeeCount(tokenAddress: string): number {
  if (!/^0x[0-9a-f]{40}$/i.test(tokenAddress)) throw new Error('A token address is required.')
  return (WakuBroadcasterClient.findBroadcastersForToken(CONFIG.chain, tokenAddress, true, true) || []).filter((fee: SelectedBroadcaster) =>
      fee.tokenFee.relayAdapt7702?.toLowerCase() === CONFIG.relayAdapt7702Contract.toLowerCase()
      && fee.tokenFee.expiration > Date.now() + 60000,
    ).length
}
