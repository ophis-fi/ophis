import { useMemo } from 'react'

import { isInjectedWidget } from '@cowprotocol/common-utils'

import { ConnectionType } from '../../../api/types'
import { getIsInjected, getIsLedgerLiveBrowser } from '../../../api/utils/connection'
import { Web3ReactConnection } from '../../types'
import { getWeb3ReactConnection } from '../../utils/getWeb3ReactConnection'

const isIframe = window.top !== window.self

export function getOrderedConnectionTypes(selectedWallet: ConnectionType | undefined): ConnectionType[] {
  const orderedConnectionTypes: ConnectionType[] = []

  // The widget's host and Ledger Wallet both inject the wallet to use: it must win over a remembered one
  if (isInjectedWidget() || getIsLedgerLiveBrowser()) {
    orderedConnectionTypes.push(ConnectionType.INJECTED)
  }

  // Always attempt to use to Gnosis Safe first in iframe, as we can't know if we're in a SafeContext.
  if (isIframe) {
    orderedConnectionTypes.push(ConnectionType.GNOSIS_SAFE)
  }

  // Add the `selectedWallet` to the top so it's prioritized, then add the other selectable wallets.
  if (selectedWallet && !orderedConnectionTypes.includes(selectedWallet)) {
    orderedConnectionTypes.push(selectedWallet)
  }

  if (getIsInjected() && !orderedConnectionTypes.includes(ConnectionType.INJECTED)) {
    orderedConnectionTypes.push(ConnectionType.INJECTED)
  }

  // Add network connection last as it should be the fallback.
  orderedConnectionTypes.push(ConnectionType.NETWORK)

  return orderedConnectionTypes
}

/**
 * `web3-react` library gives us concept of "connectors" which are react-wrappers on top of eip1193 providers.
 * `Web3ReactProvider` has a context which stores state of all active connectors.
 * It is very important! There might be more than one active connector!
 * Because of that, we need to prioritize them on this hook.
 * `web3-react` will take the first active connector from the list and use it.
 */
export function useOrderedConnections(selectedWallet: ConnectionType | undefined): Web3ReactConnection[] {
  return useMemo(() => getOrderedConnectionTypes(selectedWallet).map(getWeb3ReactConnection), [selectedWallet])
}
