import { getRpcProvider } from '@cowprotocol/common-const'
import type { JsonRpcProvider } from '@ethersproject/providers'

import { WalletFirstReadProvider, withAppRpcFallback } from './cowSdk.utils'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  getRpcProvider: jest.fn(),
}))

type Fake = JsonRpcProvider & { send: jest.Mock }
/** Wallets answer eth_chainId locally even when their RPC is dead; every other call goes to impl. */
const fake = (impl: (method: string) => unknown, chainId: unknown = '0x1'): Fake =>
  ({ send: jest.fn(async (method: string) => (method === 'eth_chainId' ? chainId : impl(method))) }) as unknown as Fake
const throwing = (error: unknown, chainId?: unknown): Fake =>
  fake(() => {
    throw error
  }, chainId)
const rpcError = (message: string, extra: object): Error => Object.assign(new Error(message), extra)
/** A wallet that cannot even answer eth_chainId. */
const mute = (): JsonRpcProvider => ({ send: jest.fn(async () => Promise.reject(dead)) }) as unknown as JsonRpcProvider
const appRpc = (): Fake => fake(() => '0x')
const read = (wallet: JsonRpcProvider, app: Fake, method = 'eth_getCode', timeout?: number): Promise<unknown> =>
  new WalletFirstReadProvider(wallet, app, 1, timeout).send(method, ['0x1'])

const dead = rpcError('Internal JSON-RPC error.', { code: -32603 })
const revert = rpcError('Internal JSON-RPC error.', {
  code: -32603,
  data: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
})

describe('WalletFirstReadProvider: the wallet RPC first, the app RPC only when a READ fails there', () => {
  it('reads through the wallet while it answers, never touching the app RPC', async () => {
    const app = appRpc()
    await expect(
      read(
        fake(() => '0xef0100aa'),
        app,
      ),
    ).resolves.toBe('0xef0100aa')
    expect(app.send).not.toHaveBeenCalled()
  })

  it.each(['eth_getCode', 'eth_call', 'eth_estimateGas'])(
    'falls back to the app RPC when the wallet fails %s at the transport level',
    async (method) => {
      await expect(read(throwing(dead), appRpc(), method)).resolves.toBe('0x')
    },
  )

  it('lets an execution-timeout transport message reach the app RPC (Codex round 13)', async () => {
    const overloaded = throwing(rpcError('request execution timed out', { code: -32603 }))
    await expect(read(overloaded, appRpc(), 'eth_call')).resolves.toBe('0x')
  })

  it('treats a wallet read that stalls as failed and answers from the app RPC (Codex)', async () => {
    await expect(
      read(
        fake(() => new Promise(() => undefined)),
        appRpc(),
        'eth_getCode',
        30,
      ),
    ).resolves.toBe('0x')
  })

  describe('never asks the app RPC when the wallet answered with', () => {
    const wrapped4100 = rpcError('Internal JSON-RPC error.', { code: -32603, data: { originalError: { code: 4100 } } })
    it.each([
      ['a revert (execution error)', revert, 'eth_call'],
      ['a revert on gas estimation', revert, 'eth_estimateGas'],
      ['4001 user rejection (Codex round 7)', rpcError('User rejected the request.', { code: 4001 }), 'eth_call'],
      ['4100 unauthorized', rpcError('Unauthorized', { code: 4100 }), 'eth_getCode'],
      ['4100 described as Forbidden (Codex round 8)', rpcError('Forbidden', { code: 4100 }), 'eth_call'],
      ['4100 nested under a -32603 wrapper (Codex round 10)', wrapped4100, 'eth_getCode'],
    ])('%s', async (_name, error, method) => {
      const app = appRpc()
      await expect(read(throwing(error), app, method)).rejects.toBe(error)
      expect(app.send).not.toHaveBeenCalled()
    })
  })

  it('never falls back for writes, signing or chain identity (Codex)', async () => {
    const app = appRpc()
    for (const method of ['eth_sendTransaction', 'eth_signTypedData_v4', 'eth_chainId', 'net_version']) {
      await expect(read(mute(), app, method)).rejects.toBe(dead)
    }
    expect(app.send).not.toHaveBeenCalled()
  })

  it('fails closed on the wallet error when the wallet no longer reports the captured chain (Codex round 3)', async () => {
    const app = appRpc()
    await expect(read(throwing(dead, '0x2105'), app)).rejects.toBe(dead)
    await expect(read(mute(), app)).rejects.toBe(dead)
    expect(app.send).not.toHaveBeenCalled()
  })

  it('discards a fallback answer when the wallet switched chain while it was in flight (Codex round 11)', async () => {
    const chainAnswers = ['0x1', '0x2105']
    const wallet = fake(() => {
      throw dead
    }, undefined)
    wallet.send.mockImplementation(async (method: string) => {
      if (method === 'eth_chainId') return chainAnswers.shift()
      throw dead
    })
    const app = appRpc()
    await expect(read(wallet, app)).rejects.toBe(dead)
    expect(app.send).toHaveBeenCalledTimes(1)
  })
})

describe('withAppRpcFallback', () => {
  const wallet = appRpc()
  const app = appRpc()

  beforeEach(() => {
    jest.mocked(getRpcProvider).mockImplementation(((chainId: number) => (chainId === 1 ? app : null)) as never)
  })

  it('wraps the wallet on a chain the app serves', () => {
    expect(withAppRpcFallback(1, wallet)).toBeInstanceOf(WalletFirstReadProvider)
  })

  it('returns the wallet itself on a chain without an app RPC, or with no chain yet', () => {
    expect(withAppRpcFallback(999, wallet)).toBe(wallet)
    expect(withAppRpcFallback(undefined, wallet)).toBe(wallet)
  })
})
