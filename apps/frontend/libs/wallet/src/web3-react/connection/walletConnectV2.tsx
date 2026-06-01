import { ReactNode } from 'react'

import { RPC_URLS } from '@cowprotocol/common-const'
import { getCurrentChainIdFromUrl } from '@cowprotocol/common-utils'
import { ALL_SUPPORTED_CHAIN_IDS, SupportedChainId } from '@cowprotocol/cow-sdk'
import { initializeConnector } from '@web3-react/core'

import { onError } from './onError'

import WalletConnectV2Image from '../../api/assets/walletConnectIcon.svg'
import { ConnectWalletOption } from '../../api/pure/ConnectWalletOption'
import { ConnectionType } from '../../api/types'
import { getConnectionName } from '../../api/utils/connection'
import { WC_PROJECT_ID } from '../../constants'
import { WalletConnectV2Connector } from '../connectors/WalletConnectV2Connector'
import { useIsActiveConnection } from '../hooks/useIsActiveConnection'
import { ConnectionOptionProps } from '../types'
import { Web3ReactConnection } from '../types'

export const walletConnectV2Option = {
  color: '#4196FC',
  icon: WalletConnectV2Image,
  id: 'wallet-connect-v2',
}

const wc2Connections = new Map<SupportedChainId, Web3ReactConnection>()

function createWalletConnectV2Connection(chainId: SupportedChainId): Web3ReactConnection {
  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://swap.ophis.fi'

  const [connector, hooks] = initializeConnector<WalletConnectV2Connector>(
    (actions) =>
      new WalletConnectV2Connector({
        actions,
        onError,
        options: {
          projectId: WC_PROJECT_ID,
          chains: [chainId],
          // Ophis fork: include OP mainnet (chain 10) in optional chains.
          // MegaETH (4326) + HyperEVM (999) dropped in PR #233 follow-up
          // to P0 hotfix.
          optionalChains: [...ALL_SUPPORTED_CHAIN_IDS, 10 as unknown as SupportedChainId],
          rpcMap: RPC_URLS,
          showQrModal: true,
          // Ophis: explicit dApp metadata so wallets never fall back to
          // auto-detecting the name/icon from index.html (which historically
          // surfaced "CoW Swap" + the cow favicon in the connect prompt).
          metadata: {
            name: 'Ophis',
            description: 'Ophis is an intent-based DEX aggregator.',
            url: appUrl,
            icons: [`${appUrl}/apple-touch-icon.png`],
          },
        },
      }),
  )

  return {
    connector,
    hooks,
    type: ConnectionType.WALLET_CONNECT_V2,
  }
}

export function getWalletConnectV2Connection(
  chainId: SupportedChainId = getCurrentChainIdFromUrl(),
): Web3ReactConnection {
  let connection = wc2Connections.get(chainId)

  if (!connection) {
    connection = createWalletConnectV2Connection(chainId)
    wc2Connections.set(chainId, connection)
  }

  return connection
}

export function WalletConnectV2Option({ selectedWallet, tryActivation }: ConnectionOptionProps): ReactNode {
  const chainId = getCurrentChainIdFromUrl()
  const connection = getWalletConnectV2Connection(chainId)

  const isActive = useIsActiveConnection(selectedWallet, connection)

  return (
    <ConnectWalletOption
      {...walletConnectV2Option}
      isActive={isActive}
      clickable={!isActive}
      onClick={() => tryActivation(connection.connector)}
      header={getConnectionName(ConnectionType.WALLET_CONNECT_V2)}
    />
  )
}
