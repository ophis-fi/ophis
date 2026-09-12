import { getRpcProvider } from '@cowprotocol/common-const'
import type { JsonRpcProvider } from '@ethersproject/providers'

import { WalletFirstReadProvider, withAppRpcFallback } from './cowSdk.utils'

jest.mock('@cowprotocol/common-const', () => ({ getRpcProvider: jest.fn() }))

function fakeProvider(impl: (method: string) => unknown): JsonRpcProvider & { send: jest.Mock } {
  return { send: jest.fn(async (method: string) => impl(method)) } as unknown as JsonRpcProvider & { send: jest.Mock }
}

describe('WalletFirstReadProvider: the wallet RPC first, the app RPC only when a READ fails there', () => {
  const dead = new Error('Internal JSON-RPC error.')

  it('reads through the wallet while it answers, never touching the app RPC', async () => {
    const wallet = fakeProvider(() => '0xef0100aa')
    const appRpc = fakeProvider(() => '0x')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_getCode', ['0x1'])).resolves.toBe('0xef0100aa')
    expect(appRpc.send).not.toHaveBeenCalled()
  })

  it('falls back to the app RPC for a read the wallet RPC fails', async () => {
    const wallet = fakeProvider(() => {
      throw dead
    })
    const appRpc = fakeProvider(() => '0x')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_getCode', ['0x1'])).resolves.toBe('0x')
    await expect(provider.send('eth_call', [{}])).resolves.toBe('0x')
    expect(appRpc.send).toHaveBeenCalledTimes(2)
  })

  it('never falls back for writes or signing', async () => {
    const wallet = fakeProvider(() => {
      throw dead
    })
    const appRpc = fakeProvider(() => '0xhash')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_sendTransaction', [{}])).rejects.toBe(dead)
    await expect(provider.send('eth_signTypedData_v4', [])).rejects.toBe(dead)
    expect(appRpc.send).not.toHaveBeenCalled()
  })
})

describe('withAppRpcFallback', () => {
  const wallet = fakeProvider(() => '0x')
  const appRpc = fakeProvider(() => '0x')

  beforeEach(() => {
    jest.mocked(getRpcProvider).mockImplementation(((chainId: number) => (chainId === 1 ? appRpc : null)) as never)
  })

  it('wraps the wallet on a chain the app serves', () => {
    expect(withAppRpcFallback(1, wallet)).toBeInstanceOf(WalletFirstReadProvider)
  })

  it('returns the wallet itself on a chain without an app RPC, or with no chain yet', () => {
    expect(withAppRpcFallback(999, wallet)).toBe(wallet)
    expect(withAppRpcFallback(undefined, wallet)).toBe(wallet)
  })
})
