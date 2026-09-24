import { ReactNode } from 'react'

import { WALLET_RPC_URLS } from '@cowprotocol/common-const'
import { isSupportedChainId } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { initializeConnector } from '@web3-react/core'

import { onError } from './onError'

import WalletConnectV2Image from '../../api/assets/walletConnectIcon.svg'
import { ConnectWalletOption } from '../../api/pure/ConnectWalletOption'
import { ConnectionType } from '../../api/types'
import { getConnectionName } from '../../api/utils/connection'
import { WC_PROJECT_ID } from '../../constants'
import { WalletConnectV2Connector } from '../connectors/WalletConnectV2Connector'
import { useIsActiveConnection } from '../hooks/useIsActiveConnection'
import { ConnectionOptionProps, Web3ReactConnection } from '../types'

export const walletConnectV2Option = {
  color: '#4196FC',
  icon: WalletConnectV2Image,
  id: 'wallet-connect-v2',
}

// One provider owns the persisted session across network changes.
const walletConnectV2Connection = createWalletConnectV2Connection()

function createWalletConnectV2Connection(): Web3ReactConnection {
  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://swap.ophis.fi'

  const [connector, hooks] = initializeConnector<WalletConnectV2Connector>(
    (actions) =>
      new WalletConnectV2Connector({
        actions,
        onError,
        options: {
          projectId: WC_PROJECT_ID,
          optionalChains: [
            SupportedChainId.MAINNET,
            ...Object.keys(WALLET_RPC_URLS)
              .map(Number)
              .filter(isSupportedChainId)
              .filter((chainId) => chainId !== SupportedChainId.MAINNET),
          ],
          // Wallet-facing, keyless RPCs: never our keyed mainnet endpoint (WALLET_RPC_URLS).
          rpcMap: WALLET_RPC_URLS,
          // The SDK's extra JSON-RPC "test" probe does not validate the network.
          disableProviderPing: true,
          showQrModal: true,
          qrModalOptions: {
            // The app's pending connection overlay uses z-index 1000.
            themeVariables: { '--wcm-z-index': '1100' },
          },
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

export function getWalletConnectV2Connection(): Web3ReactConnection {
  return walletConnectV2Connection
}

export function WalletConnectV2Option({ selectedWallet, tryActivation }: ConnectionOptionProps): ReactNode {
  const connection = getWalletConnectV2Connection()

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
