import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { AdditionalTargetChainId, TargetChainId } from '@cowprotocol/cow-sdk'

export const NEW_NETWORK_IDS: ReadonlySet<TargetChainId> = new Set([
  ARC_CHAIN_ID,
  AdditionalTargetChainId.SOLANA,
  4663 as unknown as TargetChainId, // Ophis fork: Robinhood Chain
])

export const ROW_HEIGHT_MOBILE = '64px'
export const ROW_HEIGHT_DESKTOP = '40px'

export const TAP_MOBILE = '48px'
export const TAP_DESKTOP = '32px'

export const NETWORK_ICON_SIZE_DESKTOP = '24px'
export const NETWORK_ICON_SIZE_MOBILE = '32px'
