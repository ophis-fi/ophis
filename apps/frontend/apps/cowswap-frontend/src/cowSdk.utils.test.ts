import { getRpcProvider } from '@cowprotocol/common-const'
import type { JsonRpcProvider } from '@ethersproject/providers'

import { isExecutionError, isTransportError, WalletFirstReadProvider, withAppRpcFallback } from './cowSdk.utils'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  getRpcProvider: jest.fn(),
}))

/** Wallets answer eth_chainId locally even when their RPC is dead; every other call goes to impl. */
function fakeProvider(impl: (method: string) => unknown, chainId = '0x1'): JsonRpcProvider & { send: jest.Mock } {
  return {
    send: jest.fn(async (method: string) => (method === 'eth_chainId' ? chainId : impl(method))),
  } as unknown as JsonRpcProvider & {
    send: jest.Mock
  }
}

const dead = Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 })
const revert = Object.assign(new Error('Internal JSON-RPC error.'), {
  code: -32603,
  data: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
})

describe('WalletFirstReadProvider: the wallet RPC first, the app RPC only when a READ fails there', () => {
  it('reads through the wallet while it answers, never touching the app RPC', async () => {
    const wallet = fakeProvider(() => '0xef0100aa')
    const appRpc = fakeProvider(() => '0x')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_getCode', ['0x1'])).resolves.toBe('0xef0100aa')
    expect(appRpc.send).not.toHaveBeenCalled()
  })

  it('falls back to the app RPC for a read the wallet RPC fails at the transport level', async () => {
    const wallet = fakeProvider(() => {
      throw dead
    })
    const appRpc = fakeProvider(() => '0x')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_getCode', ['0x1'])).resolves.toBe('0x')
    await expect(provider.send('eth_call', [{}])).resolves.toBe('0x')
    expect(appRpc.send).toHaveBeenCalledTimes(2)
  })

  it('surfaces an execution error from the wallet node instead of retrying elsewhere (Codex)', async () => {
    const wallet = fakeProvider(() => {
      throw revert
    })
    const appRpc = fakeProvider(() => '0xdeadbeef')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_call', [{}])).rejects.toBe(revert)
    await expect(provider.send('eth_estimateGas', [{}])).rejects.toBe(revert)
    expect(appRpc.send).not.toHaveBeenCalled()
  })

  it('never falls back for writes, signing or chain identity (Codex)', async () => {
    const wallet = { send: jest.fn(async () => Promise.reject(dead)) } as unknown as JsonRpcProvider
    const appRpc = fakeProvider(() => '0x1')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1)
    await expect(provider.send('eth_sendTransaction', [{}])).rejects.toBe(dead)
    await expect(provider.send('eth_signTypedData_v4', [])).rejects.toBe(dead)
    await expect(provider.send('eth_chainId', [])).rejects.toBe(dead)
    await expect(provider.send('net_version', [])).rejects.toBe(dead)
    expect(appRpc.send).not.toHaveBeenCalled()
  })

  it('treats a wallet read that stalls as failed and answers from the app RPC (Codex)', async () => {
    const wallet = {
      send: jest.fn((method: string) =>
        method === 'eth_chainId' ? Promise.resolve('0x1') : new Promise(() => undefined),
      ),
    } as unknown as JsonRpcProvider
    const appRpc = fakeProvider(() => '0x')
    const provider = new WalletFirstReadProvider(wallet, appRpc, 1, 30)
    await expect(provider.send('eth_getCode', ['0x1'])).resolves.toBe('0x')
  })

  it("surfaces the wallet's own policy answers (4001 rejected, 4100 unauthorized) instead of bypassing them (Codex round 7)", async () => {
    const rejected = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    const unauthorized = Object.assign(
      new Error('The requested account and/or method has not been authorized by the user.'),
      { code: 4100 },
    )
    const appRpc = fakeProvider(() => '0x')
    await expect(
      new WalletFirstReadProvider(
        fakeProvider(() => {
          throw rejected
        }),
        appRpc,
        1,
      ).send('eth_call', [{}]),
    ).rejects.toBe(rejected)
    await expect(
      new WalletFirstReadProvider(
        fakeProvider(() => {
          throw unauthorized
        }),
        appRpc,
        1,
      ).send('eth_getCode', ['0x1']),
    ).rejects.toBe(unauthorized)
    // A policy code with transport-looking text is still the wallet's answer (Codex round 8)
    const forbidden = Object.assign(new Error('Forbidden'), { code: 4100 })
    await expect(
      new WalletFirstReadProvider(
        fakeProvider(() => {
          throw forbidden
        }),
        appRpc,
        1,
      ).send('eth_call', [{}]),
    ).rejects.toBe(forbidden)
    const wrapped = Object.assign(new Error('Internal JSON-RPC error.'), {
      code: -32603,
      data: { originalError: { code: 4100 } },
    })
    await expect(
      new WalletFirstReadProvider(
        fakeProvider(() => {
          throw wrapped
        }),
        appRpc,
        1,
      ).send('eth_getCode', ['0x1']),
    ).rejects.toBe(wrapped)
    expect(appRpc.send).not.toHaveBeenCalled()
  })

  it('discards a fallback answer when the wallet switched chain while it was in flight (Codex round 11)', async () => {
    const chainAnswers = ['0x1', '0x2105']
    const wallet = {
      send: jest.fn(async (method: string) => {
        if (method === 'eth_chainId') return chainAnswers.shift()
        throw dead
      }),
    } as unknown as JsonRpcProvider
    const appRpc = fakeProvider(() => '0x')
    await expect(new WalletFirstReadProvider(wallet, appRpc, 1).send('eth_getCode', ['0x1'])).rejects.toBe(dead)
    expect(appRpc.send).toHaveBeenCalledTimes(1)
  })

  it('fails closed on the wallet error when the wallet no longer reports the captured chain (Codex round 3)', async () => {
    const switched = fakeProvider(() => {
      throw dead
    }, '0x2105')
    const appRpc = fakeProvider(() => '0x')
    await expect(new WalletFirstReadProvider(switched, appRpc, 1).send('eth_getCode', ['0x1'])).rejects.toBe(dead)
    const mute = { send: jest.fn(async () => Promise.reject(dead)) } as unknown as JsonRpcProvider
    await expect(new WalletFirstReadProvider(mute, appRpc, 1).send('eth_getCode', ['0x1'])).rejects.toBe(dead)
    expect(appRpc.send).not.toHaveBeenCalled()
  })
})

describe('isExecutionError', () => {
  it('recognises reverts in the shapes MetaMask, ethers wrappers and raw nodes produce', () => {
    expect(isExecutionError(revert)).toBe(true)
    expect(isExecutionError({ code: 3, message: 'execution reverted', data: '0x' })).toBe(true)
    expect(isExecutionError({ code: -32000, message: 'insufficient funds for gas * price + value' })).toBe(true)
    expect(isExecutionError({ code: -32000, message: 'gas required exceeds allowance (30000000)' })).toBe(true)
    // ethers SERVER_ERROR wrapping the node answer under error; MetaMask under data.originalError (Codex round 3)
    expect(
      isExecutionError({
        code: 'SERVER_ERROR',
        message: 'processing response error',
        error: { code: 3, data: '0x08c379a0' },
      }),
    ).toBe(true)
    expect(
      isExecutionError({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { originalError: { code: 3, message: 'execution reverted' } },
      }),
    ).toBe(true)
    expect(isExecutionError({ code: 'SERVER_ERROR', cause: { code: -32603, data: { code: 3 } } })).toBe(true)
    // WalletConnect-style bare strings, top level or nested as data (Codex round 4)
    expect(isExecutionError('execution reverted')).toBe(true)
    expect(
      isExecutionError({ code: -32603, message: 'Internal JSON-RPC error.', data: 'execution reverted: SPL' }),
    ).toBe(true)
    expect(isExecutionError('Internal JSON-RPC error.')).toBe(false)
    // VM failures without revert data (Codex round 6)
    for (const message of [
      'out of gas',
      'invalid opcode: INVALID',
      'stack underflow (0 <=> 1)',
      'invalid jump destination',
    ])
      expect(isExecutionError({ code: -32000, message })).toBe(true)
  })

  it('classifies connectivity, rate-limit and timeout failures as transport errors', () => {
    expect(isExecutionError(dead)).toBe(false)
    expect(isExecutionError({ code: -32005, message: 'limit exceeded' })).toBe(false)
    expect(isExecutionError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isExecutionError(new Error('wallet eth_getCode. Timeout after 10000 ms'))).toBe(false)
    expect(isExecutionError(undefined)).toBe(false)
  })
})

describe('isTransportError', () => {
  it('identifies dead endpoints, rate limits, blocked requests and timeouts', () => {
    expect(isTransportError(dead)).toBe(true)
    expect(isTransportError({ code: -32005, message: 'limit exceeded' })).toBe(true)
    expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isTransportError(new Error('wallet eth_getCode. Timeout after 10000 ms'))).toBe(true)
    expect(isTransportError({ code: 'SERVER_ERROR', message: 'bad response (status=403)' })).toBe(true)
    expect(
      isTransportError({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { message: 'Forbidden: domain not allowed' },
      }),
    ).toBe(true)
  })

  it('does not claim wallet policy answers or unknown errors', () => {
    expect(isTransportError({ code: 4001, message: 'User rejected the request.' })).toBe(false)
    expect(isTransportError({ code: 4100, message: 'Unauthorized' })).toBe(false)
    expect(isTransportError({ code: 4900, message: 'Disconnected' })).toBe(false)
    expect(isTransportError({ code: 4100, message: 'Forbidden' })).toBe(false)
    expect(isTransportError({ code: 4001, message: 'Request timeout' })).toBe(false)
    // A policy code nested under a transport wrapper still wins (Codex round 10)
    expect(
      isTransportError({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4100 } } }),
    ).toBe(false)
    expect(
      isTransportError({ code: 'SERVER_ERROR', message: 'bad response (status=403)', error: { code: 4001 } }),
    ).toBe(false)
    expect(isTransportError(new Error('something odd'))).toBe(false)
    expect(isTransportError(undefined)).toBe(false)
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
