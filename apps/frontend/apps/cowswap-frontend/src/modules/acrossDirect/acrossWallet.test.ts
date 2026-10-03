import { encodeFunctionData, pad, zeroHash, type WalletClient } from 'viem'

import { ACROSS_DEPOSIT_ABI, type AcrossQuote } from './acrossQuote.service'
import {
  ACROSS_STORAGE_KEY,
  acrossStorage,
  acrossPendingSchema,
  submitAcross,
  updateAcrossPending,
  type AcrossPending,
} from './acrossState.service'
import { arcClient, assertAcrossWallet, sendAcross } from './acrossWallet.service'

const owner = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A' as const
const hash = `0x${'ab'.repeat(32)}` as const
const getChainId = jest.fn(async () => 5042)
const getAddresses = jest.fn(async () => [owner])
const sendTransaction = jest.fn(async () => hash)
const wallet = { getChainId, getAddresses, sendTransaction } as unknown as WalletClient
function quote(): AcrossQuote {
  const timestamp = Math.floor(Date.now() / 1000)
  return {
    owner,
    recipient: owner,
    destination: 8453,
    amount: '1000000',
    output: '996000',
    quotedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    data: encodeFunctionData({
      abi: ACROSS_DEPOSIT_ABI,
      functionName: 'deposit',
      args: [
        pad(owner),
        pad(owner),
        pad('0x3600000000000000000000000000000000000000'),
        pad('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
        1000000n,
        996000n,
        8453n,
        zeroHash,
        timestamp,
        timestamp + 7200,
        0,
        '0x',
      ],
    }),
  }
}
const persist = (value: AcrossPending | null): void => acrossStorage.setItem(ACROSS_STORAGE_KEY, value)
beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  getChainId.mockResolvedValue(5042)
  getAddresses.mockResolvedValue([owner])
  sendTransaction.mockResolvedValue(hash)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (_name: string, _options: unknown, action: (lock: object) => Promise<void>) => action({})),
    },
  })
  jest.spyOn(arcClient, 'getChainId').mockResolvedValue(5042)
  jest.spyOn(arcClient, 'getCode').mockResolvedValue('0xef0100612373d7003d694220f7800eeaf8e3924c0951d3')
  jest.spyOn(arcClient, 'getGasPrice').mockResolvedValue(1000000n)
  jest.spyOn(arcClient, 'getBalance').mockResolvedValue(2000000000000000000n)
  jest.spyOn(arcClient, 'estimateGas').mockResolvedValue(100000n)
  jest.spyOn(arcClient, 'getTransactionCount').mockResolvedValue(7)
})
afterEach(() => jest.restoreAllMocks())

it('treats malformed saved amounts as invalid recovery data without crashing', () => {
  expect(acrossPendingSchema.safeParse({ ...quote(), nonce: 7, amount: 'invalid' }).success).toBe(false)
})

it('keeps corrupt storage locked instead of treating it as an unused bridge', async () => {
  localStorage.setItem(ACROSS_STORAGE_KEY, '{')
  await expect(submitAcross(wallet, quote(), persist, () => undefined)).rejects.toThrow('pending')
  expect(sendTransaction).not.toHaveBeenCalled()
})

it('accepts an EIP-7702 wallet, saving recovery before the exact deposit request', async () => {
  const q = quote()
  sendTransaction.mockImplementationOnce(async () => {
    expect(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null)).toMatchObject({ owner, nonce: 7 })
    return hash
  })
  await submitAcross(wallet, q, persist, () => undefined)
  expect(sendTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ account: owner, value: 0n, data: q.data, nonce: 7 }),
  )
  expect(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null)).toMatchObject({ hash, nonce: 7 })
  await expect(submitAcross(wallet, q, persist, () => undefined)).rejects.toThrow('pending')
  expect(sendTransaction).toHaveBeenCalledTimes(1)
})
it('keeps uncertain broadcasts locked across reloads and clears explicit rejection', async () => {
  sendTransaction.mockRejectedValueOnce({ code: 4001 })
  await expect(submitAcross(wallet, quote(), persist, () => undefined)).rejects.toEqual({ code: 4001 })
  expect(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null)).toBeNull()
  sendTransaction.mockRejectedValueOnce(new Error('Lost wallet response'))
  await expect(submitAcross(wallet, quote(), persist, () => undefined)).rejects.toThrow('Lost wallet response')
  expect(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null)).toMatchObject({ nonce: 7 })
  await expect(submitAcross(wallet, quote(), persist, () => undefined)).rejects.toThrow('pending')
})
it('fails before signing when persistence is unavailable or selection changes', async () => {
  await expect(
    submitAcross(
      wallet,
      quote(),
      () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow('save recovery')
  await expect(
    submitAcross(wallet, quote(), persist, () => {
      throw new Error('changed')
    }),
  ).rejects.toThrow('changed')
  expect(sendTransaction).not.toHaveBeenCalled()
})
it('checks the wallet network and distinguishes delegation from contract accounts', async () => {
  getChainId.mockResolvedValueOnce(8453)
  await expect(assertAcrossWallet(wallet, quote())).rejects.toThrow('network changed')
  jest.spyOn(arcClient, 'getCode').mockResolvedValueOnce('0x60006000')
  await expect(assertAcrossWallet(wallet, quote())).rejects.toThrow('Contract wallets')
})
it('reserves native USDC gas in addition to the six-decimal input amount', async () => {
  jest.spyOn(arcClient, 'getBalance').mockResolvedValueOnce(1000000000000000000n)
  const journal = jest.fn()
  await expect(sendAcross(wallet, quote(), journal, () => undefined)).rejects.toThrow('network fee')
  expect(journal).not.toHaveBeenCalled()
  expect(sendTransaction).not.toHaveBeenCalled()
})
it('rejects a transaction hash from a different transfer', async () => {
  const pending = { ...quote(), nonce: 7 }
  persist(pending)
  jest
    .spyOn(arcClient, 'getTransaction')
    .mockResolvedValue({ from: owner, to: owner, input: '0x', nonce: 7, value: 0n } as Awaited<
      ReturnType<typeof arcClient.getTransaction>
    >)
  await expect(updateAcrossPending(pending, persist, hash)).rejects.toThrow('does not match')
  expect(await acrossStorage.getItem(ACROSS_STORAGE_KEY, null)).toMatchObject({ nonce: 7 })
})
