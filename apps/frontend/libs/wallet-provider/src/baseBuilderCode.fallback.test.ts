import { getRpcProvider } from '@cowprotocol/common-const'
import { JsonRpcProvider, Web3Provider } from '@ethersproject/providers'

import { createWalletClient, custom } from 'viem'
import { base } from 'viem/chains'

import { OPHIS_BASE_DATA_SUFFIX } from './baseBuilderCode'
import { OphisBaseProvider } from './OphisBaseProvider'
import { withOphisBaseWalletClient } from './withOphisBaseWalletClient'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  getRpcProvider: jest.fn(),
}))

const address = '0x1111111111111111111111111111111111111111'
const tx = { from: address, to: address, data: '0xd0e30db0', gas: '0x10000' }
const tagged = { ...tx, data: tx.data + OPHIS_BASE_DATA_SUFFIX.slice(2) }
const hash = `0x${'12'.repeat(32)}`
const transportError = Object.assign(new Error('Service unavailable'), { code: -32603 })

describe.each(['ethers', 'viem'])('%s Base pre-submit gas fallback', (kind) => {
  let chainId: string
  let estimateError: Error
  let request: jest.Mock
  let appSend: jest.Mock
  let submit: (method: string) => Promise<unknown>

  beforeEach(() => {
    chainId = '0x2105'
    estimateError = transportError
    request = jest.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return chainId
      if (method === 'eth_estimateGas') throw estimateError
      return hash
    })
    const app = new JsonRpcProvider(undefined, 8453)
    appSend = jest.fn(async () => '0x6000')
    app.send = appSend
    jest.mocked(getRpcProvider).mockReturnValue(app)
    const ethers = new OphisBaseProvider(new Web3Provider({ request }, 8453))
    const viem = withOphisBaseWalletClient(
      createWalletClient({ chain: base, transport: custom({ request }, { retryCount: 0 }) }),
    )
    submit = (method) =>
      kind === 'ethers' ? ethers.send(method, [tx]) : viem.transport.request({ method, params: [tx] })
  })

  it.each(['eth_sendTransaction', 'wallet_sendTransaction'])(
    'estimates the attributed bytes through app RPC and sends %s only to the wallet',
    async (method) => {
      await expect(submit(method)).resolves.toBe(hash)
      expect(appSend.mock.calls).toEqual([['eth_estimateGas', [tagged]]])
      expect(request).toHaveBeenCalledWith({ method, params: [tagged] })
      expect(tx.data).toBe('0xd0e30db0')
    },
  )

  it.each([
    ['revert', Object.assign(new Error('execution reverted'), { code: 3 })],
    ['user rejection', Object.assign(new Error('User rejected'), { code: 4001 })],
    ['wallet policy', Object.assign(new Error('Forbidden'), { code: 4100 })],
    ['unknown error', new Error('Unexpected failure')],
  ])('never falls back on %s', async (_label, error) => {
    estimateError = error
    await expect(submit('eth_sendTransaction')).rejects.toThrow()
    expect(appSend).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([call]) => call.method === 'eth_sendTransaction')).toBe(false)
  })

  it.each(['0x10001', 'invalid'])("refuses fallback estimate '%s'", async (estimate) => {
    appSend.mockResolvedValue(estimate)
    await expect(submit('eth_sendTransaction')).rejects.toThrow()
    expect(request.mock.calls.some(([call]) => call.method === 'eth_sendTransaction')).toBe(false)
  })

  it('refuses to send when the fallback RPC fails', async () => {
    appSend.mockRejectedValue(new Error('Service unavailable'))
    await expect(submit('eth_sendTransaction')).rejects.toThrow()
    expect(request.mock.calls.some(([call]) => call.method === 'eth_sendTransaction')).toBe(false)
  })

  it('refuses a fallback answer after a wallet chain switch', async () => {
    appSend.mockImplementation(async () => {
      chainId = '0xa'
      return '0x6000'
    })
    await expect(submit('eth_sendTransaction')).rejects.toThrow()
    expect(request.mock.calls.some(([call]) => call.method === 'eth_sendTransaction')).toBe(false)
  })
})
