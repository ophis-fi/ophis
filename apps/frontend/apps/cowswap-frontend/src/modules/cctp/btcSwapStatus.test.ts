import { COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS, OrderStatus } from '@cowprotocol/cow-sdk'

import { orderBookApi } from 'cowSdk'
import { WBTC_ETHEREUM } from 'entities/cctp'
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, type TransactionReceipt } from 'viem'

import { parseBtcSwap, type BtcSwapPending } from './btcSwapState'
import { btcSwapReceived, getBtcSwapStatus } from './btcSwapStatus.service'
import { cctpClient } from './cctp.service'
import { cctpToken } from './cctpAssets.const'

jest.mock('cowSdk', () => ({ orderBookApi: { getOrder: jest.fn(), getTrades: jest.fn() } }))
jest.mock('./cctp.service', () => ({ cctpClient: jest.fn() }))
const owner = '0x0000000000000000000000000000000000000001'
const pending: BtcSwapPending = {
  type: 'wbtcToArc',
  owner,
  orderUid: `0x${'ab'.repeat(56)}`,
  sellAmount: '1000000',
  minimumBuyAmount: '990000',
  validTo: 1000,
}
const abi = parseAbi([
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
])
function receipt(buy = 995000n, address = COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[1]): TransactionReceipt {
  return {
    status: 'success',
    blockNumber: 5n,
    blockHash: `0x${'12'.repeat(32)}`,
    logs: [
      {
        address,
        topics: encodeEventTopics({ abi, eventName: 'Trade', args: { owner } }),
        data: encodeAbiParameters(parseAbiParameters('address,address,uint256,uint256,uint256,bytes'), [
          WBTC_ETHEREUM,
          cctpToken(1, 'cirBTC'),
          1000000n,
          buy,
          0n,
          pending.orderUid as `0x${string}`,
        ]),
      },
    ],
  } as unknown as TransactionReceipt
}
const client = {
  getBlock: jest.fn(),
  readContract: jest.fn(),
  getTransactionReceipt: jest.fn(),
}
beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  jest.mocked(orderBookApi.getOrder).mockRejectedValue({ response: { status: 404 } })
  client.getBlock.mockResolvedValue({ number: 10n, timestamp: 1001n, hash: `0x${'12'.repeat(32)}` })
  client.readContract.mockResolvedValue(0n)
  client.getTransactionReceipt.mockResolvedValue(receipt())
  jest
    .mocked(orderBookApi.getTrades)
    .mockResolvedValue([{ txHash: `0x${'12'.repeat(32)}` }] as Awaited<ReturnType<typeof orderBookApi.getTrades>>)
})

it('parses corrupt storage without throwing or accepting overflowing amounts', () => {
  expect(parseBtcSwap(pending)).toEqual(pending)
  for (const value of ['oops', '-1', '0', '1.2', (2n ** 256n).toString(), '1'.repeat(1000)]) {
    expect(parseBtcSwap({ ...pending, sellAmount: value })).toBeNull()
  }
})

it('uses verified settlement output and rejects the wrong contract, UID, amounts, or a reverted receipt', () => {
  expect(btcSwapReceived(pending, receipt())).toBe(995000n)
  expect(() => btcSwapReceived(pending, receipt(985000n))).toThrow('does not match')
  expect(() => btcSwapReceived(pending, receipt(995000n, owner))).toThrow('does not match')
  expect(() => btcSwapReceived({ ...pending, sellAmount: '1' }, receipt())).toThrow('does not match')
  expect(() => btcSwapReceived({ ...pending, orderUid: `0x${'cd'.repeat(56)}` }, receipt())).toThrow('does not match')
  expect(() => btcSwapReceived(pending, { ...receipt(), status: 'reverted' })).toThrow('does not match')
  expect(() => btcSwapReceived(pending, { ...receipt(), logs: [...receipt().logs, ...receipt().logs] })).toThrow(
    'does not match',
  )
})

it('handles actual SDK 404 errors but never releases a journal before finalized expiry', async () => {
  client.getBlock.mockResolvedValueOnce({ number: 10n, timestamp: 999n })
  expect((await getBtcSwapStatus(pending)).ended).toBeUndefined()
  expect(client.readContract).not.toHaveBeenCalled()
  jest.mocked(orderBookApi.getTrades).mockResolvedValueOnce([])
  const expired = await getBtcSwapStatus(pending)
  expect(expired.ended).toBe(true)
  expect(expired.text).toContain('could not be verified')
  jest.mocked(orderBookApi.getOrder).mockRejectedValueOnce({ response: { status: 503 } })
  await expect(getBtcSwapStatus(pending)).rejects.toEqual({ response: { status: 503 } })
})

it('recovers a finalized fill even if the orderbook incorrectly reports missing or expired', async () => {
  client.readContract.mockResolvedValue(0n)
  expect((await getBtcSwapStatus(pending)).amount).toBe('995000')
  jest
    .mocked(orderBookApi.getOrder)
    .mockResolvedValue({ status: OrderStatus.EXPIRED, receiver: owner, partiallyFillable: false } as Awaited<
      ReturnType<typeof orderBookApi.getOrder>
    >)
  expect((await getBtcSwapStatus(pending)).amount).toBe('995000')
  expect(orderBookApi.getOrder).toHaveBeenCalledWith(pending.orderUid, { chainId: 1, env: 'prod' })
})

it('verifies fulfilled orders before handing any amount to the bridge', async () => {
  jest
    .mocked(orderBookApi.getOrder)
    .mockResolvedValue({ status: OrderStatus.FULFILLED, receiver: owner, partiallyFillable: false } as Awaited<
      ReturnType<typeof orderBookApi.getOrder>
    >)
  expect((await getBtcSwapStatus(pending)).amount).toBe('995000')
  expect(client.readContract).not.toHaveBeenCalled()
  client.getTransactionReceipt.mockResolvedValue(receipt(1n))
  await expect(getBtcSwapStatus(pending)).rejects.toThrow('does not match')
})

it('requires finalized canonical receipts and recovers without the orderbook from a verified hash', async () => {
  const recovered = { ...pending, settlementHash: `0x${'12'.repeat(32)}` as `0x${string}` }
  client.getBlock.mockResolvedValueOnce({ number: 4n })
  expect((await getBtcSwapStatus(recovered)).amount).toBeUndefined()
  expect((await getBtcSwapStatus(recovered)).amount).toBe('995000')
  expect(orderBookApi.getOrder).not.toHaveBeenCalled()
  expect(orderBookApi.getTrades).not.toHaveBeenCalled()
  client.getBlock.mockResolvedValue({ number: 10n, hash: `0x${'34'.repeat(32)}` })
  expect((await getBtcSwapStatus(recovered)).amount).toBeUndefined()
})
