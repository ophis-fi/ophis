import { EventEmitter } from 'events'

import { WalletConnectV2Connector } from './index'

import type EthereumProvider from '@walletconnect/ethereum-provider'

const account = '0x0000000000000000000000000000000000000001'
const session = {
  namespaces: { eip155: { accounts: [100, 4663].map((chain) => `eip155:${chain}:${account}`) } },
}
const provider = Object.assign(new EventEmitter(), {
  chainId: 100,
  accounts: [account],
  session: session as typeof session | undefined,
  signer: { setDefaultChain: jest.fn() },
  enable: jest.fn(),
  disconnect: jest.fn(),
  request: jest.fn(),
})
const actions = { startActivation: jest.fn(() => jest.fn()), update: jest.fn(), resetState: jest.fn() }
const init = jest.fn()
// pnpm gives the upstream connector its own peer-resolved provider instance.
jest.doMock(
  require.resolve('@walletconnect/ethereum-provider', {
    paths: [require.resolve('@web3-react/walletconnect-v2')],
  }),
  () => ({ __esModule: true, default: { init } }),
)

function createConnector(): WalletConnectV2Connector {
  return new WalletConnectV2Connector({
    actions,
    options: {
      projectId: 'test-project',
      optionalChains: [1, 100, 4663],
      showQrModal: true,
      rpcMap: { 1: 'https://example.com/1', 100: 'https://example.com/100', 4663: 'https://example.com/4663' },
    },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  provider.removeAllListeners()
  provider.session = session
  provider.chainId = 100
  provider.accounts = [account]
  init.mockResolvedValue(provider as unknown as EthereumProvider)
  provider.enable.mockResolvedValue([account])
  provider.disconnect.mockResolvedValue(undefined)
  provider.request.mockResolvedValue(null)
})

test('offers the requested network first without requiring wallet support for it', async () => {
  provider.session = undefined
  provider.enable.mockImplementationOnce(async () => {
    provider.session = session
    return provider.accounts
  })
  await createConnector().activate(4663)
  expect(init).toHaveBeenCalledWith(
    expect.objectContaining({
      chains: undefined,
      optionalChains: [4663, 1, 100],
    }),
  )
  // The wallet approved Gnosis first; reads and displayed state must follow its actual chain.
  expect(provider.signer.setDefaultChain).toHaveBeenLastCalledWith('eip155:100')
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 100, accounts: [account] })
})

test('restores a session without requesting connection or a network switch', async () => {
  await createConnector().connectEagerly()
  expect(provider.enable).not.toHaveBeenCalled()
  expect(provider.request).not.toHaveBeenCalled()
  expect(provider.signer.setDefaultChain).toHaveBeenLastCalledWith('eip155:100')
  provider.emit('chainChanged', '0x1237')
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 4663 })
  provider.emit('accountsChanged', [])
  expect(actions.update).toHaveBeenLastCalledWith({ accounts: [] })
  provider.emit('disconnect')
  expect(actions.resetState).toHaveBeenCalled()
})

test('does not request a switch to a chain the wallet did not approve', async () => {
  await expect(createConnector().activate(1)).rejects.toThrow('Cannot activate an optional chain')
  expect(provider.request).not.toHaveBeenCalled()
  expect(provider.disconnect).not.toHaveBeenCalled()
})

test('aligns RPC reads after an approved wallet switch', async () => {
  provider.request.mockImplementationOnce(async () => {
    provider.chainId = 4663
  })
  await createConnector().activate(4663)
  expect(provider.request).toHaveBeenCalledWith({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x1237' }],
  })
  expect(provider.signer.setDefaultChain).toHaveBeenLastCalledWith('eip155:4663')
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 4663, accounts: [account] })
})

test('can retry a failed provider initialization', async () => {
  init.mockRejectedValueOnce(new Error('Relay unavailable'))
  const connector = createConnector()
  await expect(connector.activate(100)).rejects.toThrow('Relay unavailable')
  await connector.activate(100)
  expect(init).toHaveBeenCalledTimes(2)
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 100, accounts: [account] })
})

test('clears a cancelled connection so retry initializes again', async () => {
  provider.session = undefined
  provider.enable.mockRejectedValueOnce(new Error('Connection request reset. Please try again.'))
  const connector = createConnector()
  await expect(connector.activate(100)).rejects.toThrow('Connection request reset')
  expect(actions.resetState).toHaveBeenCalled()
  expect(provider.listenerCount('accountsChanged')).toBe(0)
  await connector.activate(100)
  expect(init).toHaveBeenCalledTimes(2)
})
