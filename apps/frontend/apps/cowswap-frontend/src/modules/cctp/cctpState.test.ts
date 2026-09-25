import { createJSONStorage } from 'jotai/utils'

import { type WalletClient } from 'viem'

import { type CctpTransfer } from './cctp.service'
import { CCTP_STORAGE_KEY, cctpStorage, cctpTransferSchema } from './cctpState'
import { submitCctpBurn } from './cctpSubmission.service'
import { burnCctp } from './cctpWallet.service'

jest.mock('./cctpWallet.service', () => ({ burnCctp: jest.fn() }))
const legacyKey = 'cctpTransfer:v1'
const raw = createJSONStorage<unknown>()
const transfer: CctpTransfer = {
  source: 8453,
  destination: 5042,
  owner: '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A',
  amount: '2000000',
  maxFee: '15638',
  quotedAt: 1000,
}
const persist = (value: CctpTransfer | null): void => cctpStorage.setItem(CCTP_STORAGE_KEY, value)

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  raw.removeItem(legacyKey)
  raw.removeItem(CCTP_STORAGE_KEY)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (_name: string, _options: unknown, action: (lock: object) => Promise<void>) => action({})),
    },
  })
})

it('reads legacy USDC without hydration writes and migrates with an old-tab burn guard on update', () => {
  raw.setItem(legacyKey, transfer)
  expect(cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(transfer)
  expect(raw.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
  const updated = { ...transfer, sourceNonce: 7 }
  persist(updated)
  expect(raw.getItem(CCTP_STORAGE_KEY, null)).toEqual(updated)
  const guard = raw.getItem(legacyKey, null)
  expect(guard).toEqual({ version: 2, recoveryKey: CCTP_STORAGE_KEY })
  expect(cctpTransferSchema.safeParse(guard).success).toBe(false)
  expect(cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(updated)
  persist(null)
  expect(raw.getItem(legacyKey, null)).toBeNull()
  expect(raw.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
})

it.each([CCTP_STORAGE_KEY, legacyKey, 'silent legacy failure'])(
  'never signs if a journal or legacy guard write fails: %s',
  async (failure) => {
    const write = Storage.prototype.setItem
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === legacyKey && failure === 'silent legacy failure') return
      if (key === failure) throw new Error('Storage unavailable')
      write.call(this, key, value)
    })
    const signed = jest.fn()
    jest.mocked(burnCctp).mockImplementation(async (_wallet, _quote, beforeSignature) => {
      await beforeSignature(7)
      signed()
      return `0x${'ab'.repeat(32)}`
    })
    await expect(submitCctpBurn({} as WalletClient, transfer, persist)).rejects.toThrow()
    expect(signed).not.toHaveBeenCalled()
    expect(raw.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
    expect(raw.getItem(legacyKey, null)).toBeNull()
    jest.restoreAllMocks()
    await submitCctpBurn({} as WalletClient, transfer, persist)
    expect(signed).toHaveBeenCalledTimes(1)
  },
)

it('restores an existing legacy journal if migration cannot protect older tabs', () => {
  raw.setItem(legacyKey, transfer)
  const write = Storage.prototype.setItem
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === legacyKey) throw new Error('Storage unavailable')
    write.call(this, key, value)
  })
  expect(() => persist({ ...transfer, sourceNonce: 7 })).toThrow('Storage unavailable')
  expect(raw.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
  expect(cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(transfer)
})
