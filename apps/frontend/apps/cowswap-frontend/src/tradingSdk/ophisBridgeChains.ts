import { toBridgeChainInfo } from '@cowprotocol/common-const'
import { EvmChainInfo } from '@cowprotocol/cow-sdk'

// toBridgeChainInfo moved to common-const (shared with the explorer and the
// NEAR destination registration); re-exported so existing imports keep working.
export { toBridgeChainInfo }

export const UNICHAIN_BRIDGE_CHAIN: EvmChainInfo = toBridgeChainInfo(130)
export const ROBINHOOD_BRIDGE_CHAIN: EvmChainInfo = toBridgeChainInfo(4663)
