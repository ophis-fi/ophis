import { WALLET_RPC_URLS } from '@cowprotocol/common-const'
import { isSupportedChainId } from '@cowprotocol/common-utils'

import { EventEmitter } from 'events'

import { WalletConnectV2Connector } from './index'

import type EthereumProvider from '@walletconnect/ethereum-provider'

const account = '0x0000000000000000000000000000000000000001'
const configuredChains = [
  1,
  ...Object.keys(WALLET_RPC_URLS)
    .map(Number)
    .filter(isSupportedChainId)
    .filter((chain) => chain !== 1),
]
function createSession(chains = [100, 4663]): { namespaces: { eip155: { accounts: string[] } } } {
  return { namespaces: { eip155: { accounts: chains.map((chain) => `eip155:${chain}:${account}`) } } }
}
const session = createSession()
const provider = Object.assign(new EventEmitter(), {
  chainId: 100,
  accounts: [account],
  session: session as typeof session | undefined,
  signer: { setDefaultChain: jest.fn() },
  enable: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  request: jest.fn(),
})
const cancelActivation = jest.fn()
const actions = { startActivation: jest.fn(() => cancelActivation), update: jest.fn(), resetState: jest.fn() }
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
      optionalChains: configuredChains,
      showQrModal: true,
      rpcMap: Object.fromEntries(configuredChains.map((chain) => [chain, `https://example.com/${chain}`])),
    },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  provider.removeAllListeners()
  provider.session = session
  provider.chainId = 100
  provider.accounts = [account]
  init.mockReset().mockResolvedValue(provider as unknown as EthereumProvider)
  provider.connect.mockReset().mockImplementation(async () => {
    provider.session = session
    provider.accounts = [account]
  })
  provider.enable.mockReset().mockImplementation(async () => {
    await provider.connect()
    return provider.accounts
  })
  provider.disconnect.mockReset().mockImplementation(async () => {
    provider.session = undefined
    provider.accounts = []
    provider.emit('disconnect')
  })
  provider.request.mockReset().mockImplementation(async ({ params }: { params: [{ chainId: string }] }) => {
    provider.chainId = Number.parseInt(params[0].chainId, 16)
    provider.emit('chainChanged', params[0].chainId)
  })
})

function expectSingleProvider(connector: WalletConnectV2Connector): void {
  expect(init).toHaveBeenCalledTimes(1)
  expect(connector.provider).toBe(provider)
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect', 'display_uri']) {
    expect(provider.listenerCount(event)).toBe(1)
  }
}

test('offers the requested network first without requiring wallet support for it', async () => {
  provider.session = undefined
  await createConnector().activate(4663)
  expect(init).toHaveBeenCalledWith(
    expect.objectContaining({
      chains: undefined,
      optionalChains: [4663, ...configuredChains.filter((chain) => chain !== 4663)],
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

test('reuses the eagerly initialized provider and puts the requested optional chain first', async () => {
  provider.session = undefined
  const connector = createConnector()
  await expect(connector.connectEagerly()).rejects.toThrow('No active session')
  expect(provider.connect).not.toHaveBeenCalled()
  expect(cancelActivation).toHaveBeenCalledTimes(1)
  await connector.activate(4663)
  expect(provider.connect).toHaveBeenCalledWith({
    chains: undefined,
    optionalChains: [4663, ...configuredChains.filter((chain) => chain !== 4663)],
  })
  expect(provider.request).not.toHaveBeenCalled()
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 100, accounts: [account] })
  expect(provider.signer.setDefaultChain).toHaveBeenLastCalledWith('eip155:100')
  expectSingleProvider(connector)
})

test.each([false, true])('retries a cancelled QR connection on the same provider (eager=%s)', async (eager) => {
  provider.session = undefined
  const connector = createConnector()
  if (eager) await expect(connector.connectEagerly()).rejects.toThrow('No active session')
  cancelActivation.mockClear()
  provider.connect.mockRejectedValueOnce(new Error('Connection request reset. Please try again.'))
  await expect(connector.activate(100)).rejects.toThrow('Connection request reset')
  expect(cancelActivation).toHaveBeenCalledTimes(1)
  expect(provider.session).toBeUndefined()
  expect(provider.accounts).toEqual([])
  expectSingleProvider(connector)
  await connector.activate(100)
  expect(provider.enable).toHaveBeenCalledTimes(eager ? 0 : 1)
  expect(provider.connect).toHaveBeenCalledTimes(2)
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 100, accounts: [account] })
  expectSingleProvider(connector)
})

test('disconnects the session but reuses its provider and listeners for another network', async () => {
  const connector = createConnector()
  await connector.activate(100)
  await connector.deactivate()
  expect(provider.disconnect).toHaveBeenCalledTimes(1)
  expect(provider.session).toBeUndefined()
  expect(provider.accounts).toEqual([])
  expectSingleProvider(connector)
  provider.connect.mockImplementationOnce(async () => {
    provider.session = session
    provider.chainId = 4663
    provider.accounts = [account]
  })
  await connector.activate(4663)
  expect(provider.connect).toHaveBeenCalledWith({
    chains: undefined,
    optionalChains: [4663, ...configuredChains.filter((chain) => chain !== 4663)],
  })
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 4663, accounts: [account] })
  expect(provider.signer.setDefaultChain).toHaveBeenLastCalledWith('eip155:4663')
  expectSingleProvider(connector)
})

test('switches repeatedly across configured approved networks without duplicating providers or listeners', async () => {
  provider.session = createSession(configuredChains)
  const connector = createConnector()
  for (const chainId of [...configuredChains, ...configuredChains].reverse()) {
    await connector.activate(chainId)
    expect(actions.update).toHaveBeenLastCalledWith({ chainId, accounts: [account] })
    expect(provider.signer.setDefaultChain).toHaveBeenLastCalledWith(`eip155:${chainId}`)
    expectSingleProvider(connector)
  }
  expect(provider.connect).not.toHaveBeenCalled()
  expect(provider.disconnect).not.toHaveBeenCalled()
})

test('cancels an invalid reconnect activation and permits the next valid retry', async () => {
  const connector = createConnector()
  await connector.activate(100)
  await connector.deactivate()
  await expect(connector.activate(-1)).rejects.toThrow('Invalid chainId -1')
  expect(cancelActivation).toHaveBeenCalledTimes(1)
  expect(provider.connect).not.toHaveBeenCalled()
  await connector.activate(100)
  expect(actions.startActivation).toHaveBeenCalledTimes(2)
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 100, accounts: [account] })
  expectSingleProvider(connector)
})

test('waits for a deduplicated disconnect before immediate reconnect', async () => {
  const connector = createConnector()
  await connector.activate(100)
  actions.update.mockClear()
  const deferred: { finish?: () => void } = {}
  const pending = new Promise<void>((resolve) => {
    deferred.finish = resolve
  })
  provider.disconnect.mockImplementationOnce(async () => {
    await pending
    provider.session = undefined
    provider.accounts = []
  })
  const disconnects = [connector.deactivate(), connector.deactivate()]
  const reconnect = connector.activate(4663)
  await Promise.resolve()
  expect(actions.resetState).toHaveBeenCalled()
  expect(provider.disconnect).toHaveBeenCalledTimes(1)
  expect(provider.connect).not.toHaveBeenCalled()
  expect(actions.update).not.toHaveBeenCalled()
  deferred.finish?.()
  await Promise.all([...disconnects, reconnect])
  expect(provider.connect).toHaveBeenCalledTimes(1)
  expect(actions.update).toHaveBeenLastCalledWith({ chainId: 100, accounts: [account] })
  expectSingleProvider(connector)
})
