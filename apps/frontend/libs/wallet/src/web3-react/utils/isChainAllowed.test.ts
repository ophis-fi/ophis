import { Connector } from '@web3-react/types'

import { ConnectionType } from '../../api/types'

test.each([false, true])('permits Arc wallet switching only when the local flag enables it: %s', (enabled) => {
  jest.isolateModules(() => {
    jest.doMock('./getWeb3ReactConnection', () => ({
      getWeb3ReactConnection: () => ({ type: ConnectionType.INJECTED }),
    }))
    jest.doMock('@cowprotocol/common-const', () => ({ ARC_ENABLED_CHAIN_IDS: enabled ? [5042] : [] }))
    const { isChainAllowed } = require('./isChainAllowed') as typeof import('./isChainAllowed')
    const connector = {} as Connector
    expect(isChainAllowed(connector, 5042)).toBe(enabled)
    expect(isChainAllowed(connector, 8453)).toBe(true)
    expect(isChainAllowed(connector, 123456789)).toBe(false)
  })
})
