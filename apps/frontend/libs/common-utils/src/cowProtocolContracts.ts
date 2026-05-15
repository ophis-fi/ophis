import { OLD_BARN_ETH_FLOW_ADDRESS, STAGING_MIGRATED_CONTRACT_NETWORKS } from '@cowprotocol/common-const'
import {
  AddressPerChain,
  BARN_ETH_FLOW_ADDRESSES,
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS as COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS_PROD,
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS_STAGING,
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS as COW_PROTOCOL_VAULT_RELAYER_ADDRESS_PROD,
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS_STAGING,
  ETH_FLOW_ADDRESSES,
  mapAddressToSupportedNetworks,
  SupportedChainId,
} from '@cowprotocol/cow-sdk'

import { isBarnBackendEnv } from './environments'

// Ophis fork: OP mainnet (chain 10) contract addresses (Ophis-deployed Settlement + VaultRelayer)
const OPHIS_OPTIMISM_CHAIN_ID = 10 as unknown as SupportedChainId
const OPHIS_OP_SETTLEMENT: `0x${string}` = '0x310784c7FCE12d578dA6f53460777bAc9718B859'
const OPHIS_OP_VAULT_RELAYER: `0x${string}` = '0x83847EaB41ad9ea43809ce71569eB2e9daF51830'
// ETH Flow is not deployed on OP for Ophis; empty disables EthFlow UI.
const OPHIS_OP_ETH_FLOW: `0x${string}` = '0x0000000000000000000000000000000000000000'

// Ophis fork: MegaETH mainnet (chain 4326) contract addresses
// Settlement + VaultRelayer deployed 2026-05-15 (CREATE2-deterministic, same as OP).
// Update these once contracts are live. The zero-address sentinel keeps the
// frontend from crashing but will reject any swap attempt at signing time.
const OPHIS_MEGAETH_CHAIN_ID = 4326 as unknown as SupportedChainId
const OPHIS_MEGAETH_SETTLEMENT: `0x${string}` = '0x310784c7FCE12d578dA6f53460777bAc9718B859' // Spec 3 deploy 2026-05-15
const OPHIS_MEGAETH_VAULT_RELAYER: `0x${string}` = '0x83847EaB41ad9ea43809ce71569eB2e9daF51830' // Spec 3 deploy 2026-05-15
// ETH Flow not deployed on MegaETH for Ophis; sentinel zero address disables EthFlow UI.
const OPHIS_MEGAETH_ETH_FLOW: `0x${string}` = '0x0000000000000000000000000000000000000000'

// When in barn backend env, use staging contracts for MAINNET only; prod for all other chains.
// TODO: the condition should be removed once all backend services migrated to the new contracts
export const COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS: AddressPerChain = {
  ...(isBarnBackendEnv
    ? ({
        ...COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS_PROD,
        ...STAGING_MIGRATED_CONTRACT_NETWORKS.reduce((acc, chainId) => {
          acc[chainId] = COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS_STAGING[chainId] as `0x${string}`
          return acc
        }, {} as AddressPerChain),
      } as AddressPerChain)
    : (COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS_PROD as AddressPerChain)),
  [OPHIS_OPTIMISM_CHAIN_ID]: OPHIS_OP_SETTLEMENT,
  [OPHIS_MEGAETH_CHAIN_ID]: OPHIS_MEGAETH_SETTLEMENT,
}

// When in barn backend env, use the staging vault relayer for MAINNET only; prod for all other chains.
// TODO: the condition should be removed once all backend services migrated to the new contracts
export const COW_PROTOCOL_VAULT_RELAYER_ADDRESS: AddressPerChain = {
  ...(isBarnBackendEnv
    ? ({
        ...COW_PROTOCOL_VAULT_RELAYER_ADDRESS_PROD,
        ...STAGING_MIGRATED_CONTRACT_NETWORKS.reduce((acc, chainId) => {
          acc[chainId] = COW_PROTOCOL_VAULT_RELAYER_ADDRESS_STAGING[chainId] as `0x${string}`
          return acc
        }, {} as AddressPerChain),
      } as AddressPerChain)
    : (COW_PROTOCOL_VAULT_RELAYER_ADDRESS_PROD as AddressPerChain)),
  [OPHIS_OPTIMISM_CHAIN_ID]: OPHIS_OP_VAULT_RELAYER,
  [OPHIS_MEGAETH_CHAIN_ID]: OPHIS_MEGAETH_VAULT_RELAYER,
}

// When in barn backend env, use the staging vault relayer for MAINNET only; prod for all other chains.
// TODO: the condition should be removed once all backend services migrated to the new contracts
export const COW_PROTOCOL_ETH_FLOW_ADDRESS: AddressPerChain = {
  ...(isBarnBackendEnv
    ? ({
        ...mapAddressToSupportedNetworks(OLD_BARN_ETH_FLOW_ADDRESS),
        ...STAGING_MIGRATED_CONTRACT_NETWORKS.reduce((acc, chainId) => {
          acc[chainId] = BARN_ETH_FLOW_ADDRESSES[chainId] as `0x${string}`
          return acc
        }, {} as AddressPerChain),
      } as AddressPerChain)
    : (ETH_FLOW_ADDRESSES as AddressPerChain)),
  // ETH Flow not deployed on OP for Ophis; sentinel zero address disables EthFlow UI.
  [OPHIS_OPTIMISM_CHAIN_ID]: OPHIS_OP_ETH_FLOW,
  // ETH Flow not deployed on MegaETH for Ophis; sentinel zero disables EthFlow UI.
  [OPHIS_MEGAETH_CHAIN_ID]: OPHIS_MEGAETH_ETH_FLOW,
}
