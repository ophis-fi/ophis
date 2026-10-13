import { getOrderedConnectionTypes } from './useOrderedConnections'

import { ConnectionType } from '../../../api/types'

afterEach(() => {
  delete window.ethereum
})

it('puts the injected wallet ahead of a remembered wallet inside Ledger Wallet only', () => {
  window.ethereum = { providers: [] }
  expect(getOrderedConnectionTypes(ConnectionType.WALLET_CONNECT_V2)).toEqual([
    ConnectionType.WALLET_CONNECT_V2,
    ConnectionType.INJECTED,
    ConnectionType.NETWORK,
  ])

  window.ethereum = { isLedgerLive: true, providers: [] }
  expect(getOrderedConnectionTypes(ConnectionType.WALLET_CONNECT_V2)).toEqual([
    ConnectionType.INJECTED,
    ConnectionType.WALLET_CONNECT_V2,
    ConnectionType.NETWORK,
  ])
})
