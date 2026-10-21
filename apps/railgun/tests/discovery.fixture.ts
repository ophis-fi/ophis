import { WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web'
import { POI_REQUIRED_LISTS } from '@railgun-community/shared-models'
import { JsonRpcProvider } from 'ethers'
import { CONFIG, FEE_SIGNER, TOKENS } from '../src/config'

// Read-only discovery: no wallet session, proofs, authorizations or transaction submission.
export async function discoverBroadcasters(): Promise<void> {
  const provider = new JsonRpcProvider(new URL('/rpc', location.origin).href)
  if (!(await provider.send('anvil_metadata', [])).forkedNetwork) throw new Error('Local test origin required.')
  provider.destroy()
  await WakuBroadcasterClient.start(
    CONFIG.chain,
    {
      trustedFeeSigner: FEE_SIGNER,
      poiActiveListKeys: POI_REQUIRED_LISTS.map((list) => list.key),
      enableHealthcheckLogs: false,
    },
    (_chain, status) => console.info('[discovery]', status),
  )
}

export function discoveredFees(): { usdc: number; weth: number; canonical7702: number } {
  const usdc = WakuBroadcasterClient.findBroadcastersForToken(CONFIG.chain, TOKENS.USDC.address, true, true) || []
  const weth = WakuBroadcasterClient.findBroadcastersForToken(CONFIG.chain, TOKENS.WETH.address, true, true) || []
  return {
    usdc: usdc.length,
    weth: weth.length,
    canonical7702: [...usdc, ...weth].filter(
      (fee) =>
        fee.tokenFee.relayAdapt7702?.toLowerCase() === CONFIG.relayAdapt7702Contract.toLowerCase() &&
        fee.tokenFee.expiration > Date.now() + 60_000,
    ).length,
  }
}
