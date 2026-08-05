import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

export const TENDERLY_AVAILABLE: Record<SupportedChainId, boolean> = {
  ...mapSupportedNetworks(true),
  // Ophis fork: Tenderly not configured for OP mainnet (chain 10)
  [10 as unknown as SupportedChainId]: false,
  // Ophis fork: Tenderly not configured for Unichain mainnet (chain 130)
  [130 as unknown as SupportedChainId]: false,
  [4663 as unknown as SupportedChainId]: false,
}
