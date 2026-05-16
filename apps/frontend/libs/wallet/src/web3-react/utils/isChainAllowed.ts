import { ALL_SUPPORTED_CHAIN_IDS, SupportedChainId } from '@cowprotocol/cow-sdk'
import { Connector } from '@web3-react/types'

import { getWeb3ReactConnection } from './getWeb3ReactConnection'

import { ConnectionType } from '../../api/types'

// Ophis fork: include OP mainnet (chain 10), MegaETH mainnet (chain 4326),
// and HyperEVM mainnet (chain 999) alongside SDK-supported chains.
const OPHIS_ALL_SUPPORTED_CHAIN_IDS: SupportedChainId[] = [
  ...ALL_SUPPORTED_CHAIN_IDS,
  10 as unknown as SupportedChainId,
  4326 as unknown as SupportedChainId,
  999 as unknown as SupportedChainId,
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
