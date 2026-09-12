import { getRpcProvider } from '@cowprotocol/common-const'
import type { JsonRpcProvider } from '@ethersproject/providers'

import { pickSdkReadProvider } from './cowSdk.utils'

jest.mock('@cowprotocol/common-const', () => ({ getRpcProvider: jest.fn() }))

const appRpc = { name: 'app-rpc' } as unknown as JsonRpcProvider
const wallet = { name: 'wallet' } as unknown as JsonRpcProvider

describe('pickSdkReadProvider: SDK reads never depend on the wallet RPC when the app has its own', () => {
  beforeEach(() => {
    jest.mocked(getRpcProvider).mockImplementation(((chainId: number) => (chainId === 1 ? appRpc : null)) as never)
  })

  it('reads through the app RPC on a chain the app serves', () => {
    expect(pickSdkReadProvider(1, wallet)).toBe(appRpc)
  })

  it('falls back to the wallet provider on a chain without an app RPC, or with no chain yet', () => {
    expect(pickSdkReadProvider(999, wallet)).toBe(wallet)
    expect(pickSdkReadProvider(undefined, wallet)).toBe(wallet)
    expect(getRpcProvider).not.toHaveBeenCalledWith(undefined)
  })
})
