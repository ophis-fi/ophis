import { mapAddressToSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

export const DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK: Record<SupportedChainId, string> = {
  ...mapAddressToSupportedNetworks('0x22af3D38E50ddedeb7C47f36faB321eC3Bb72A76'),
  // Ophis fork: OP mainnet partner-fee Safe
  [10 as unknown as SupportedChainId]: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
  // Ophis fork: MegaETH mainnet (chain 4326) — TBD post-deploy, reuse default Safe placeholder
  [4326 as unknown as SupportedChainId]: '0x22af3D38E50ddedeb7C47f36faB321eC3Bb72A76',
}
