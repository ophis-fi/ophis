import { SupportedChainId, mapAddressToSupportedNetworks } from '@cowprotocol/cow-sdk'

const composableCowAddress = '0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74'
export const COMPOSABLE_COW_ADDRESS: Record<SupportedChainId, string> = {
  ...mapAddressToSupportedNetworks(composableCowAddress),
  // Ophis fork: OP mainnet (chain 10) — canonical ComposableCoW
  [10 as unknown as SupportedChainId]: composableCowAddress,
  // Ophis fork: MegaETH mainnet (chain 4326) — TBD post-deploy. Placeholder is
  // the canonical address; will only function once ComposableCoW is deployed on MegaETH.
  [4326 as unknown as SupportedChainId]: composableCowAddress,
}

const extensibleHandlerAddress = '0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5'
export const SAFE_EXTENSIBLE_HANDLER_ADDRESS: Record<SupportedChainId, string> = {
  ...mapAddressToSupportedNetworks(extensibleHandlerAddress),
  // Ophis fork: OP mainnet (chain 10) — canonical Safe ExtensibleFallbackHandler
  [10 as unknown as SupportedChainId]: extensibleHandlerAddress,
  // Ophis fork: MegaETH mainnet (chain 4326) — TBD post-deploy.
  [4326 as unknown as SupportedChainId]: extensibleHandlerAddress,
}

const currentBlockFactoryAddress = '0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc'
export const CURRENT_BLOCK_FACTORY_ADDRESS: Record<SupportedChainId, string> = {
  ...mapAddressToSupportedNetworks(currentBlockFactoryAddress),
  // Ophis fork: OP mainnet (chain 10) — canonical CurrentBlock factory
  [10 as unknown as SupportedChainId]: currentBlockFactoryAddress,
  // Ophis fork: MegaETH mainnet (chain 4326) — TBD post-deploy.
  [4326 as unknown as SupportedChainId]: currentBlockFactoryAddress,
}
