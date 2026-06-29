import { ALL_SUPPORTED_CHAIN_IDS, SupportedChainId } from '@cowprotocol/cow-sdk'
import { Connector } from '@web3-react/types'

import { getWeb3ReactConnection } from './getWeb3ReactConnection'

import { ConnectionType } from '../../api/types'

// Ophis fork: include OP mainnet (chain 10) alongside SDK-supported chains.
// MegaETH (4326) + HyperEVM (999) dropped in PR #233 follow-up to P0
// hotfix — `true` for chains absent from CHAIN_INFO leaks into
// downstream getChainInfo() callers that crash on undefined.
const OPHIS_ALL_SUPPORTED_CHAIN_IDS: SupportedChainId[] = [
  ...ALL_SUPPORTED_CHAIN_IDS,
  10 as unknown as SupportedChainId,
  130 as unknown as SupportedChainId,
]

const allowedChainsByWallet: Record<ConnectionType, SupportedChainId[]> = {
  [ConnectionType.INJECTED]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
  [ConnectionType.METAMASK]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
  [ConnectionType.COINBASE_WALLET]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
  [ConnectionType.WALLET_CONNECT_V2]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
  [ConnectionType.NETWORK]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
  [ConnectionType.GNOSIS_SAFE]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
  [ConnectionType.TREZOR]: OPHIS_ALL_SUPPORTED_CHAIN_IDS,
}

export function isChainAllowed(connector: Connector, chainId: number): boolean {
  const connection = getWeb3ReactConnection(connector)

  return allowedChainsByWallet[connection.type].includes(chainId)
}
