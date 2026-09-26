import { RPC_URLS } from '@cowprotocol/common-const'
import { getCurrentChainIdFromUrl } from '@cowprotocol/common-utils'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { initializeConnector } from '@web3-react/core'
import { Network } from '@web3-react/network'

import { ConnectionType } from '../../api/types'
import { Web3ReactConnection } from '../types'

const defaultChainId = getCurrentChainIdFromUrl()

// Each URL is pinned to one chain. Browsing without a wallet must not depend on
// an eth_chainId handshake succeeding; actual RPC reads still report failures.
const providers = Object.fromEntries(
  Object.entries(RPC_URLS).map(([chainId, url]) => [chainId, new StaticJsonRpcProvider(url, Number(chainId))]),
)

const [web3Network, web3NetworkHooks] = initializeConnector<Network>(
  (actions) => new Network({ actions, urlMap: providers, defaultChainId }),
)
export const networkConnection: Web3ReactConnection = {
  connector: web3Network,
  hooks: web3NetworkHooks,
  type: ConnectionType.NETWORK,
}
