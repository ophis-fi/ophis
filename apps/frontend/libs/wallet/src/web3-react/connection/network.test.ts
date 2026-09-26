import { JsonRpcProvider } from '@ethersproject/providers'

import { networkConnection } from './network'

jest.mock('@cowprotocol/common-const', () => ({
  RPC_URLS: { 1: 'https://ethereum.invalid', 5042: 'https://arc.invalid' },
}))
jest.mock('@cowprotocol/common-utils', () => ({ getCurrentChainIdFromUrl: () => 1 }))

afterEach(() => jest.restoreAllMocks())

test('can browse configured networks while RPCs are unavailable, without hiding read failures', async () => {
  const send = jest.spyOn(JsonRpcProvider.prototype, 'send').mockRejectedValue(new Error('RPC unavailable'))
  const { connector } = networkConnection

  for (const chainId of [1, 5042, 1, 5042]) {
    await connector.activate(chainId)
    expect(await connector.customProvider?.getNetwork()).toMatchObject({ chainId })
    expect(connector.customProvider?.connection.url).toBe(
      chainId === 5042 ? 'https://arc.invalid' : 'https://ethereum.invalid',
    )
  }
  expect(send).not.toHaveBeenCalled()

  await expect(connector.customProvider?.getBlockNumber()).rejects.toThrow('RPC unavailable')
  expect(send).toHaveBeenCalledWith('eth_blockNumber', [])
})
