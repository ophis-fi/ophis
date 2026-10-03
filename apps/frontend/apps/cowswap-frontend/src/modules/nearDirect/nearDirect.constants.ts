import {
  HYPERCORE_CHAIN_ID,
  MONAD_CHAIN_ID,
  STARKNET_CHAIN_ID,
  SUI_CHAIN_ID,
  TRON_CHAIN_ID,
  XLAYER_CHAIN_ID,
  ZCASH_CHAIN_ID,
} from '@cowprotocol/common-const'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'

export const SOURCE_WALLET_CHAINS = ['starknet', 'sol', 'sui', 'tron']

// Source capability is independent of the CoW settlement chain registry.
export const DIRECT_NEAR_CHAINS: Readonly<Record<string, { id: number; label: string }>> = {
  btc: { id: AdditionalTargetChainId.BITCOIN, label: 'Bitcoin' },
  monad: { id: MONAD_CHAIN_ID, label: 'Monad' },
  tron: { id: TRON_CHAIN_ID, label: 'Tron' },
  sol: { id: AdditionalTargetChainId.SOLANA, label: 'Solana' },
  xlayer: { id: XLAYER_CHAIN_ID, label: 'X Layer' },
  sui: { id: SUI_CHAIN_ID, label: 'Sui' },
  hypercore: { id: HYPERCORE_CHAIN_ID, label: 'Hyperliquid (Hypercore)' },
  starknet: { id: STARKNET_CHAIN_ID, label: 'Starknet' },
  zec: { id: ZCASH_CHAIN_ID, label: 'Zcash' },
  eth: { id: 1, label: 'Ethereum' },
  base: { id: 8453, label: 'Base' },
  arb: { id: 42161, label: 'Arbitrum' },
  op: { id: 10, label: 'Optimism' },
  pol: { id: 137, label: 'Polygon' },
  bsc: { id: 56, label: 'BNB' },
  avax: { id: 43114, label: 'Avalanche' },
  gnosis: { id: 100, label: 'Gnosis' },
  plasma: { id: 9745, label: 'Plasma' },
  hood: { id: 4663, label: 'Robinhood Chain' },
}
