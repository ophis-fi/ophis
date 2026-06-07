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

// Ophis fork: MegaETH mainnet (chain 4326) contract addresses
// Settlement + VaultRelayer deployed 2026-05-15 (CREATE2-deterministic, same as OP).
// Update these once contracts are live. The zero-address sentinel keeps the
// frontend from crashing but will reject any swap attempt at signing time.
const OPHIS_MEGAETH_CHAIN_ID = 4326 as unknown as SupportedChainId
const OPHIS_MEGAETH_SETTLEMENT: `0x${string}` = '0x310784c7FCE12d578dA6f53460777bAc9718B859' // Spec 3 deploy 2026-05-15
const OPHIS_MEGAETH_VAULT_RELAYER: `0x${string}` = '0x83847EaB41ad9ea43809ce71569eB2e9daF51830' // Spec 3 deploy 2026-05-15
// ETH Flow not deployed on MegaETH for Ophis; sentinel zero address disables EthFlow UI.
const OPHIS_MEGAETH_ETH_FLOW: `0x${string}` = '0x0000000000000000000000000000000000000000'

// Ophis fork: HyperEVM mainnet (chain 999) contract addresses.
// Deployed 2026-05-15 (task #107). EthFlow deployed 2026-05-17.
const OPHIS_HYPEREVM_CHAIN_ID = 999 as unknown as SupportedChainId
const OPHIS_HYPEREVM_SETTLEMENT: `0x${string}` = '0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce'
const OPHIS_HYPEREVM_VAULT_RELAYER: `0x${string}` = '0x842F655C9310C32e5932A0eBFa80c4Cd358c0205'
// EthFlow contract for native HYPE → ERC-20 swaps.
// Deployed 2026-05-17 (PR #61); contract verified on-chain; WHYPE→VaultRelayer
// allowance is MAX_UINT256. Tx: 0x9ae599088605c7e2270feb8da914bb1252cd81625…
//
// Re-enabled 2026-05-17 after the companion pnpm patch landed
// (PR for `feat/sdk-patch-chain-999-reenable-ethflow`). The patch injects
// chain 999 entries into the SDK's internal maps:
//   - @cowprotocol/sdk-config@2.0.0: WRAPPED_NATIVE_CURRENCIES, ETH_FLOW_ADDRESSES,
//     BARN_ETH_FLOW_ADDRESSES
//   - @cowprotocol/sdk-trading@2.0.2: ETH_FLOW_DEFAULT_SLIPPAGE_BPS
// Without those, `adjustEthFlowOrderParams(999, …)` in the trading SDK threw
// synchronously on `WRAPPED_NATIVE_CURRENCIES[999].address` before the HTTP
// request, surfaced as "Quote fetch failed" with no network entry.
const OPHIS_HYPEREVM_ETH_FLOW: `0x${string}` = '0xd031Ce1C577caD1530BD8283CaA6a6a106A5b61B'

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
  [OPHIS_HYPEREVM_CHAIN_ID]: OPHIS_HYPEREVM_SETTLEMENT,
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
  [OPHIS_HYPEREVM_CHAIN_ID]: OPHIS_HYPEREVM_VAULT_RELAYER,
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
  // EthFlow deployed on HyperEVM (2026-05-17): native HYPE sells go through
  // 0xd031Ce1C…b61B. See OPHIS_HYPEREVM_ETH_FLOW comment above for context.
  [OPHIS_HYPEREVM_CHAIN_ID]: OPHIS_HYPEREVM_ETH_FLOW,
}
