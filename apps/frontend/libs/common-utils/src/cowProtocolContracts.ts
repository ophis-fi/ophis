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
// CoWSwapEthFlow deployed on OP 2026-06-07 (tx 0xc0316c2c…c48e),
// constructor-wired to the OP settlement (0x310784c7) + WETH (0x4200), WETH
// allowance to vaultRelayer (0x83847EaB) = MAX. Enables native-ETH sells via
// EthFlow. Backend autopilot indexes this contract (configs/autopilot.toml).
const OPHIS_OP_ETH_FLOW: `0x${string}` = '0x764fE4aa1FF493cf39931c7923C8ff5837596504'

// Ophis fork: Unichain mainnet (chain 130) contract addresses (Ophis-deployed
// GPv2 Settlement + VaultRelayer). Verified on-chain 2026-06-29 via RPC:
// Settlement.vaultRelayer() -> 0xaB29…59cb and Settlement.authenticator() ->
// 0x1002E12f… (matches the recorded Ophis Unichain Auth proxy).
const OPHIS_UNICHAIN_CHAIN_ID = 130 as unknown as SupportedChainId
const OPHIS_UNICHAIN_SETTLEMENT: `0x${string}` = '0x108A678716e5E1776036eF044CAB7064226F714E'
const OPHIS_UNICHAIN_VAULT_RELAYER: `0x${string}` = '0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb'
// EthFlow IS live on Unichain (deployed 2026-06-29): native-ETH selling routes
// through this address. Do NOT zero it — that silently disables native-ETH orders.
const OPHIS_UNICHAIN_ETH_FLOW: `0x${string}` = '0x38C03729153BCCF6a281DaF41D7C6a14C543F1D7'

// Ophis fork: Robinhood Chain mainnet (4663). Contracts verified on-chain
// after the sovereign deployment ceremony. EthFlow was deployed 2026-07-28
// and is constructor-wired to the settlement and Robinhood WETH below.
const OPHIS_ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const OPHIS_ROBINHOOD_SETTLEMENT: `0x${string}` = '0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD'
const OPHIS_ROBINHOOD_VAULT_RELAYER: `0x${string}` = '0xB52C38097c19cd38238c62DD36027a7918eFa890'
const OPHIS_ROBINHOOD_ETH_FLOW: `0x${string}` = '0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29'

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
  [OPHIS_UNICHAIN_CHAIN_ID]: OPHIS_UNICHAIN_SETTLEMENT,
  [OPHIS_ROBINHOOD_CHAIN_ID]: OPHIS_ROBINHOOD_SETTLEMENT,
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
  [OPHIS_UNICHAIN_CHAIN_ID]: OPHIS_UNICHAIN_VAULT_RELAYER,
  [OPHIS_ROBINHOOD_CHAIN_ID]: OPHIS_ROBINHOOD_VAULT_RELAYER,
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
  // ETH Flow IS live on Unichain (2026-06-29): native-ETH sells via 0x38C0…F1D7.
  [OPHIS_UNICHAIN_CHAIN_ID]: OPHIS_UNICHAIN_ETH_FLOW,
  // EthFlow is not deployed on Robinhood; sentinel zero disables native sells.
  [OPHIS_ROBINHOOD_CHAIN_ID]: OPHIS_ROBINHOOD_ETH_FLOW,
}
