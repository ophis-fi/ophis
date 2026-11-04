import { afterEach, expect, it, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

const state = vi.hoisted(() => ({ load: vi.fn(), authenticate: vi.fn(), scan: vi.fn(), create: vi.fn(),
  saved: { id: 'test-wallet', salt: `0x${'11'.repeat(32)}` } as unknown,
}))
vi.mock('./storage', () => ({
  readPreference: async () => state.saved,
  encryptionKey: async (password: string) => password,
  writePreference: vi.fn(),
  walletDB: {},
  artifacts: {},
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  loadWalletByID: state.load,
  getWalletMnemonic: state.authenticate,
  createRailgunWallet: state.create,
  fullWalletForID: () => ({}),
  EphemeralKeyManager: class {
    scanHistoryForEphemeralIndex = state.scan
  },
}))
import { newMnemonic, openWallet } from './wallet'
import { NETWORK } from './config'

afterEach(() => vi.unstubAllGlobals())

it('authenticates retries even when a failed opening left a cached SDK wallet', async () => {
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) },
  })
  const provider = {} as JsonRpcProvider
  state.load.mockResolvedValue({ id: 'test-wallet', railgunAddress: 'test-address' })
  state.authenticate.mockImplementation(async (key: string) => {
    if (key !== 'correct-test-password') throw new Error('Invalid password')
    return 'discarded-test-mnemonic'
  })
  state.scan.mockRejectedValueOnce(new Error('History temporarily unavailable')).mockResolvedValue(undefined)

  await expect(openWallet(provider, 'correct-test-password', undefined)).rejects.toThrow(/History/)
  // Model the SDK cache: loadWalletByID would also succeed with this wrong key.
  await expect(openWallet(provider, 'incorrect-test-password', undefined)).rejects.toThrow(/Invalid password/)
  expect(state.load).toHaveBeenCalledTimes(1)
  await expect(openWallet(provider, 'correct-test-password', undefined)).resolves.toMatchObject({
    info: { id: 'test-wallet' },
  })
  expect(state.authenticate).toHaveBeenCalledTimes(3)
})

it.each([false, true])('uses a creation height only for a newly generated wallet, fresh=%s', async (fresh) => {
  state.saved = undefined
  state.scan.mockResolvedValue(undefined)
  state.create.mockReset().mockResolvedValue({ id: 'new-wallet', railgunAddress: 'test-address' })
  const block = vi.fn().mockResolvedValue(123456)
  await openWallet({ getBlockNumber: block } as unknown as JsonRpcProvider, 'test-only-password', newMnemonic(), fresh)
  expect(state.create.mock.calls[0][2]).toEqual(fresh ? { [NETWORK]: 123456 } : undefined)
  expect(block).toHaveBeenCalledTimes(fresh ? 1 : 0)
})
