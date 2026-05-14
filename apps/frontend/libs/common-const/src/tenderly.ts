import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

export const TENDERLY_AVAILABLE: Record<SupportedChainId, boolean> = {
  ...mapSupportedNetworks(true),
  // Ophis fork: Tenderly not configured for OP mainnet (chain 10)
  [10 as unknown as SupportedChainId]: false,
}
