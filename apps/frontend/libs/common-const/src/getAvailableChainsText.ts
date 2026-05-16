import { ADDITIONAL_TARGET_CHAINS_MAP, ALL_SUPPORTED_CHAINS_MAP, isSupportedChain } from '@cowprotocol/cow-sdk'

import { CHAIN_INFO, SORTED_CHAIN_IDS } from './chainInfo'

export function getAvailableChainsText(): string {
  return SORTED_CHAIN_IDS.reduce((acc, chainId) => {
    // Resolve chain info: prefer the SDK's authoritative maps where present,
    // fall back to the local CHAIN_INFO for Ophis-added chains (MegaETH
    // 4326, HyperEVM 999) that aren't in the upstream @cowprotocol/cow-sdk
    // maps. Without this fallback the destructure below explodes with
    // "Cannot destructure property 'label' of undefined" the moment React
    // first renders any component that uses this text — full white-screen
    // crash on every page load (see Ophis fix/frontend-chains-text-crash
    // PR for the production incident this guards).
    const info =
      (isSupportedChain(chainId)
        ? ALL_SUPPORTED_CHAINS_MAP[chainId]
        : ADDITIONAL_TARGET_CHAINS_MAP[chainId]) ?? CHAIN_INFO[chainId]
    if (!info) return acc

    const { label, isTestnet, isUnderDevelopment, isDeprecated } = info as {
      label: string
      isTestnet?: boolean
      isUnderDevelopment?: boolean
      isDeprecated?: boolean
    }

    if (!isUnderDevelopment && !isDeprecated) {
      acc.push(`${label}${isTestnet ? ' (testnet)' : ''}`)
    }
    return acc
  }, [] as string[])
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1')
}
