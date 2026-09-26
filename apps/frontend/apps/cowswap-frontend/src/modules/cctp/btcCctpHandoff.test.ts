import { type WalletClient } from 'viem'

import { type BtcSwapPending } from './btcSwapState'
import { getBtcSwapStatus } from './btcSwapStatus.service'
import { type CctpTransfer } from './cctp.service'
import { cctpStorage, CCTP_STORAGE_KEY } from './cctpState'
import { submitCctpBurn } from './cctpSubmission.service'
import { burnCctp } from './cctpWallet.service'

jest.mock('./btcSwapStatus.service', () => ({ getBtcSwapStatus: jest.fn() }))
jest.mock('./cctpWallet.service', () => ({ burnCctp: jest.fn() }))
const owner = '0x0000000000000000000000000000000000000001'
const pending: BtcSwapPending = {
  type: 'wbtcToArc',
  owner,
  orderUid: `0x${'ab'.repeat(56)}`,
  sellAmount: '1000000',
  minimumBuyAmount: '990000',
  validTo: 1000,
}
const quote: CctpTransfer = {
  owner,
  source: 1,
  destination: 5042,
  asset: 'cirBTC',
  amount: '995000',
  maxFee: '0',
  quotedAt: 1000,
  swapOrderUid: pending.orderUid,
  expanded: {
    signedQuote: `0x${'11'.repeat(100)}`,
    feeTotalAmount: '1000',
    issuedAt: 1000,
    expiry: { mode: 'TIMESTAMP', expiresAt: 2000 },
  },
}
const wallet = {} as WalletClient
const persist = (value: CctpTransfer | BtcSwapPending | null): void => cctpStorage.setItem(CCTP_STORAGE_KEY, value)
beforeEach(() => {
  jest.resetAllMocks()
  persist(pending)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (_name: string, _options: unknown, action: (lock: object) => Promise<void>) => action({})),
    },
  })
  jest.mocked(getBtcSwapStatus).mockResolvedValue({ amount: '995000', text: 'finalized' })
})

it('restores the swap on rejected bridge signing, but retains an uncertain burn and prohibits a second burn', async () => {
  jest.mocked(burnCctp).mockImplementationOnce(async (_wallet, _quote, beforeSignature) => {
    await beforeSignature(4)
    expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual({ ...quote, sourceNonce: 4 })
    throw { code: 4001 }
  })
  await expect(submitCctpBurn(wallet, quote, persist)).rejects.toEqual({ code: 4001 })
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(pending)
  jest.mocked(burnCctp).mockImplementationOnce(async (_wallet, _quote, beforeSignature) => {
    await beforeSignature(4)
    throw new Error('broadcast unknown')
  })
  await expect(submitCctpBurn(wallet, quote, persist)).rejects.toThrow('broadcast unknown')
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual({ ...quote, sourceNonce: 4 })
  await expect(submitCctpBurn(wallet, quote, persist)).rejects.toThrow('already pending')
  expect(burnCctp).toHaveBeenCalledTimes(2)
})

it('requires the exact saved UID, owner, chain pair, canonical asset and finalized received amount', async () => {
  for (const patch of [
    { swapOrderUid: undefined },
    { owner: `0x${'11'.repeat(20)}` },
    { source: 8453 },
    { destination: 1 },
    { asset: 'USDC' },
    { amount: '995001' },
  ]) {
    await expect(submitCctpBurn(wallet, { ...quote, ...patch } as CctpTransfer, persist)).rejects.toThrow(
      'already pending',
    )
  }
  jest.mocked(getBtcSwapStatus).mockResolvedValue({ text: 'waiting for finality' })
  await expect(submitCctpBurn(wallet, quote, persist)).rejects.toThrow('already pending')
  expect(burnCctp).not.toHaveBeenCalled()
  persist(null)
  await expect(submitCctpBurn(wallet, quote, persist)).rejects.toThrow('already pending')
})
