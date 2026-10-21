import { afterEach, expect, it, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

const state = vi.hoisted(() => ({ load: vi.fn(), authenticate: vi.fn(), scan: vi.fn() }))
vi.mock('./storage', () => ({
  readPreference: async () => ({ id: 'test-wallet', salt: `0x${'11'.repeat(32)}` }),
  encryptionKey: async (password: string) => password,
  writePreference: vi.fn(),
  walletDB: {},
  artifacts: {},
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  loadWalletByID: state.load,
  getWalletMnemonic: state.authenticate,
  fullWalletForID: () => ({}),
  EphemeralKeyManager: class {
    scanHistoryForEphemeralIndex = state.scan
  },
}))
import { openWallet } from './wallet'

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
