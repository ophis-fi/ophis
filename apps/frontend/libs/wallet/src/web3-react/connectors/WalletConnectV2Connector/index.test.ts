import { WalletConnectV2Connector } from './index'

const setDefaultChain = jest.fn()
const update = jest.fn()

jest.mock('@web3-react/walletconnect-v2', () => ({
  WalletConnect: class {
    async activate(): Promise<void> {}
    async connectEagerly(): Promise<void> {}
  },
}))

test('aligns WalletConnect RPC reads with the selected chain on fresh and restored sessions', async () => {
  const connector = Object.create(WalletConnectV2Connector.prototype) as WalletConnectV2Connector
  Object.assign(connector, {
    provider: { chainId: 100, accounts: ['0x123'], session: {}, signer: { setDefaultChain } },
    actions: { update },
  })
  await connector.activate(100)
  expect(setDefaultChain).toHaveBeenLastCalledWith('eip155:100')
  setDefaultChain.mockClear()
  await connector.connectEagerly()
  expect(setDefaultChain).toHaveBeenLastCalledWith('eip155:100')
})
