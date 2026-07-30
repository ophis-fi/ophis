import { SORTED_CHAIN_IDS } from '@cowprotocol/common-const'
import { ALL_SUPPORTED_CHAIN_IDS } from '@cowprotocol/cow-sdk'

/**
 * Explorer-wide chain list. The SDK list does not include Ophis-operated
 * frontend chains such as Robinhood, while the frontend list omits testnets.
 */
export const EXPLORER_SUPPORTED_CHAIN_IDS = Array.from(new Set([...ALL_SUPPORTED_CHAIN_IDS, ...SORTED_CHAIN_IDS]))
