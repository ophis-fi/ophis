import { mapAddressToSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

export const DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK: Record<SupportedChainId, string> = {
  ...mapAddressToSupportedNetworks('0x22af3D38E50ddedeb7C47f36faB321eC3Bb72A76'),
  // Ophis fork: OP mainnet partner-fee Safe
  [10 as unknown as SupportedChainId]: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
  // Ophis fork: MegaETH mainnet (chain 4326) — Safe deployed 2026-05-12, same CREATE2 address as OP
  [4326 as unknown as SupportedChainId]: '0x22af3D38E50ddedeb7C47f36faB321eC3Bb72A76',
  // Ophis fork: HyperEVM mainnet (chain 999) — dedicated partner-fee Safe deployed 2026-05-15
  [999 as unknown as SupportedChainId]: '0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF',
}
