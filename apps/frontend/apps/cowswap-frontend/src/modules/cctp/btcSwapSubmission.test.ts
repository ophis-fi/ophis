import {
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS,
  OrderKind,
} from '@cowprotocol/cow-sdk'

import { orderBookApi } from 'cowSdk'
import { WBTC_ETHEREUM } from 'entities/cctp'
import { decodeFunctionData, erc20Abi, type Hex, type WalletClient } from 'viem'

import { type BtcSwapQuote } from './btcSwapQuote.service'
import { parseBtcSwap, type BtcSwapPending } from './btcSwapState'
import { approveBtcSwap, submitBtcSwap, updateBtcSwap } from './btcSwapSubmission.service'
import { cctpClient } from './cctp.service'
import { cctpToken } from './cctpAssets.const'
import { cctpStorage, CCTP_STORAGE_KEY } from './cctpState'
import { assertCctpWallet } from './cctpWallet.service'

jest.mock('cowSdk', () => ({ orderBookApi: { sendOrder: jest.fn() } }))
jest.mock('./cctp.service', () => ({ ...jest.requireActual('./cctp.service'), cctpClient: jest.fn() }))
jest.mock('./cctpWallet.service', () => ({ assertCctpWallet: jest.fn() }))
const owner = '0x0000000000000000000000000000000000000001'
const signature: Hex = `0x${'ab'.repeat(65)}`
const hash: Hex = `0x${'12'.repeat(32)}`
const signTypedData = jest.fn()
const sendTransaction = jest.fn()
const wallet = { signTypedData, sendTransaction } as unknown as WalletClient
const persist = (value: BtcSwapPending | null): void => cctpStorage.setItem(CCTP_STORAGE_KEY, value)
const client = {
  readContract: jest.fn(),
  getCode: jest.fn(),
  call: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
  chain: { id: 1 },
}
function quote(): BtcSwapQuote {
  return {
    quotedAt: Date.now(),
    bridge: {
      source: 1,
      destination: 5042,
      owner,
      amount: '995000',
      maxFee: '0',
      quotedAt: Date.now(),
      asset: 'cirBTC',
    },
    swap: {
      orderToSign: {
        sellToken: WBTC_ETHEREUM,
        buyToken: cctpToken(1, 'cirBTC'),
        receiver: owner,
        sellAmount: '1000000',
        buyAmount: '995000',
        feeAmount: '0',
        kind: OrderKind.SELL,
        partiallyFillable: false,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
        validTo: Math.floor(Date.now() / 1000) + 300,
        appData: hash,
      },
      quoteResponse: { id: 123 },
      appDataInfo: { fullAppData: '{"appCode":"Ophis"}', appDataKeccak256: hash },
    },
  } as BtcSwapQuote
}
beforeEach(() => {
  jest.resetAllMocks()
  persist(null)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (_name: string, _options: unknown, action: (lock: object) => Promise<void>) => action({})),
    },
  })
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  client.readContract.mockResolvedValue(1000000n)
  client.getCode.mockResolvedValue('0x')
  client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  signTypedData.mockResolvedValue(signature)
  sendTransaction.mockResolvedValue(hash)
  jest
    .mocked(orderBookApi.sendOrder)
    .mockImplementation(async () => parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))?.orderUid || '')
})

it('journals the exact UID before signing and submits the fixed Ethereum settlement domain with quote appData', async () => {
  signTypedData.mockImplementation(async () => {
    expect(parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))?.orderUid).toMatch(/^0x[a-f0-9]{112}$/)
    return signature
  })
  const review = quote()
  await submitBtcSwap(wallet, review, persist, () => undefined)
  expect(signTypedData).toHaveBeenCalledWith(
    expect.objectContaining({
      account: owner,
      domain: expect.objectContaining({ chainId: 1, verifyingContract: COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[1] }),
      message: review.swap.orderToSign,
    }),
  )
  expect(orderBookApi.sendOrder).toHaveBeenCalledWith(
    expect.objectContaining({
      signature,
      quoteId: 123,
      from: owner,
      appData: review.swap.appDataInfo.fullAppData,
      appDataHash: hash,
    }),
    { chainId: 1, env: 'prod' },
  )
  expect(assertCctpWallet).toHaveBeenCalledWith(wallet, owner, 1)
})

it('retains an ambiguous submission and rejects another route, but clears explicit wallet signature rejection', async () => {
  jest.mocked(orderBookApi.sendOrder).mockRejectedValueOnce(new Error('connection lost'))
  await expect(submitBtcSwap(wallet, quote(), persist, () => undefined)).rejects.toThrow('connection lost')
  expect(parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))).not.toBeNull()
  await expect(submitBtcSwap(wallet, quote(), persist, () => undefined)).rejects.toThrow('already pending')
  expect(signTypedData).toHaveBeenCalledTimes(1)
  persist(null)
  signTypedData.mockRejectedValueOnce({ code: 4001 })
  await expect(submitBtcSwap(wallet, quote(), persist, () => undefined)).rejects.toEqual({ code: 4001 })
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
  jest.mocked(orderBookApi.sendOrder).mockRejectedValueOnce({ code: 4001 })
  await expect(submitBtcSwap(wallet, quote(), persist, () => undefined)).rejects.toEqual({ code: 4001 })
  expect(parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))).not.toBeNull()
})

it('prevents signing with unsaved recovery, a stale quote, code-bearing destination, or a changed wallet', async () => {
  await expect(
    submitBtcSwap(
      wallet,
      quote(),
      () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow('Could not save')
  await expect(
    submitBtcSwap(wallet, { ...quote(), quotedAt: Date.now() - 60001 }, persist, () => undefined),
  ).rejects.toThrow('Refresh')
  client.getCode.mockResolvedValueOnce('0x').mockResolvedValueOnce('0x1234')
  await expect(submitBtcSwap(wallet, quote(), persist, () => undefined)).rejects.toThrow('personal wallets')
  const changed = (): void => {
    throw new Error('changed')
  }
  await expect(submitBtcSwap(wallet, quote(), persist, changed)).rejects.toThrow('changed')
  expect(signTypedData).not.toHaveBeenCalled()
})

it('never submits after a wallet/context change following signature and keeps its signature journal', async () => {
  const current = jest
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error('changed')
    })
  await expect(submitBtcSwap(wallet, quote(), persist, current)).rejects.toThrow('changed')
  expect(orderBookApi.sendOrder).not.toHaveBeenCalled()
  expect(parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))).not.toBeNull()
})

it('approves exactly the WBTC input for the production relayer and rejects reverted approvals', async () => {
  await approveBtcSwap(wallet, quote(), () => undefined)
  const transaction = sendTransaction.mock.calls[0]?.[0]
  expect(transaction).toMatchObject({ account: owner, to: WBTC_ETHEREUM, value: 0n })
  expect(decodeFunctionData({ abi: erc20Abi, data: transaction.data })).toMatchObject({
    functionName: 'approve',
    args: [COW_PROTOCOL_VAULT_RELAYER_ADDRESS[1], 1000000n],
  })
  client.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' })
  await expect(approveBtcSwap(wallet, quote(), () => undefined)).rejects.toThrow('reverted')
})

it('serializes recovery against other tabs and never overwrites an advanced journal', async () => {
  await submitBtcSwap(wallet, quote(), persist, () => undefined)
  const pending = parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))
  if (!pending) throw new Error('Missing test journal')
  await updateBtcSwap(pending, async () => ({ ...pending, settlementHash: hash }), persist)
  await expect(updateBtcSwap(pending, async () => null, persist)).rejects.toThrow('changed in another tab')
  expect(parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))?.settlementHash).toBe(hash)
})
