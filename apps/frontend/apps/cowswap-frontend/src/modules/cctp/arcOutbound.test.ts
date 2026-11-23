import {
  ARC_CHAIN_ID,
  ARC_USDC,
  ARC_USDC_ADDRESS,
  USDC_BASE,
  USDC_POLYGON,
  ACROSS_V5_ADAPTER,
  RELAY_DEPOSIT,
  type AcrossV5Quote,
} from '@cowprotocol/common-const'

import { arcOutboundBuyTokens, hasWalletBridgeRoute, isArcOutboundPair } from 'entities/cctp'
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type WalletClient } from 'viem'

import { arcAllowance, quoteArcDeposit, sendArcDeposit } from './arcOutbound.service'
import * as cctp from './cctp.service'
import relayFixture from './fixtures/usdc-arc-base.json'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  RELAY_ENABLED: true,
  getRpcProvider: () => ({ getCode: async () => '0x' }),
}))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
afterEach(() => jest.restoreAllMocks())

const owner: Address = '0x1111111111111111111111111111111111111111'
const orderId = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const data = encodeFunctionData({
  abi: parseAbi(['function store(bytes32,address,uint256)']),
  functionName: 'store',
  args: [orderId, ARC_USDC_ADDRESS, 1_000_000n],
})
function response(depositData = data): AcrossV5Quote {
  const now = Math.floor(Date.now() / 1000)
  return {
    orderId,
    expiresAt: now + 90,
    originValidUntil: now + 400,
    amount: '1000000',
    expectedOutput: '990000',
    minimumOutput: '980000',
    grossOutput: '1000000',
    appFee: '300',
    depositData,
  }
}
it('discovers exact six-decimal Arc USDC and excludes unrelated assets, chains and directions', () => {
  expect(hasWalletBridgeRoute(ARC_CHAIN_ID, USDC_POLYGON.chainId)).toBe(true)
  expect(isArcOutboundPair(ARC_USDC, USDC_POLYGON)).toBe(true)
  expect(
    arcOutboundBuyTokens({ sellChainId: ARC_CHAIN_ID, buyChainId: USDC_POLYGON.chainId, sellTokenAddress: owner }),
  ).toEqual([])
  expect(isArcOutboundPair(USDC_BASE, ARC_USDC)).toBe(false)
  expect(arcOutboundBuyTokens({ sellChainId: ARC_CHAIN_ID, buyChainId: 4663 })).toEqual([])
})
it('binds Across funding to the wallet, full deposit and selected destination before any approval', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => response() } as Response)
  const quote = await quoteArcDeposit('Across', owner, USDC_BASE.chainId, 1_000_000n)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
    originChainId: 5042,
    destinationChainId: 8453,
    inputToken: ARC_USDC_ADDRESS,
    outputToken: USDC_BASE.address,
    amount: '1000000',
    recipient: owner,
    depositor: owner,
  })
  expect(quote.spender.toLowerCase()).toBe(ACROSS_V5_ADAPTER)
  expect(quote.data).toBe(data)
  fetcher.mockResolvedValue({ ok: true, json: async () => response('0xdeadbeef') } as Response)
  await expect(quoteArcDeposit('Across', owner, 8453, 1_000_000n)).rejects.toThrow('Invalid or expired')
})
it('rechecks the form and allowance, and records the nonce before sending the reviewed deposit', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => response() } as Response)
  const quote = await quoteArcDeposit('Across', owner, 8453, 1_000_000n)
  const client = {
    readContract: jest.fn().mockResolvedValue(quote.amount),
    estimateGas: async () => 45_000n,
    getCode: jest.fn().mockResolvedValue(undefined),
    getGasPrice: async () => 20_000_000_000n,
    getBalance: jest.fn().mockResolvedValue(3n * 10n ** 18n),
    getTransactionCount: async () => 7,
  }
  jest.spyOn(cctp, 'cctpClient').mockReturnValue(client as unknown as ReturnType<typeof cctp.cctpClient>)
  const record = jest.fn()
  const send = jest.fn(async () => {
    expect(record).toHaveBeenCalledWith(7)
    return orderId
  })
  const wallet = {
    getChainId: async () => 5042,
    getAddresses: async () => [owner],
    sendTransaction: send,
  } as unknown as WalletClient
  const changed = (): never => {
    throw new Error('changed')
  }
  await expect(sendArcDeposit(wallet, quote, false, changed, record)).rejects.toThrow('changed')
  expect(record).not.toHaveBeenCalled()
  await expect(sendArcDeposit(wallet, { ...quote, expires: 0 }, false, () => {}, record)).rejects.toThrow('expired')
  expect(send).not.toHaveBeenCalled()
  await sendArcDeposit(wallet, quote, false, () => {}, record)
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ account: owner, to: quote.spender, data, nonce: 7, value: 0n }),
  )
  client.readContract.mockResolvedValueOnce(0n)
  await expect(sendArcDeposit(wallet, quote, false, () => {}, record)).rejects.toThrow('Allowance changed')
  expect(await arcAllowance(quote)).toBe(quote.amount)
  client.getCode.mockResolvedValueOnce('0xef0100')
  await expect(sendArcDeposit(wallet, quote, false, () => {}, record)).rejects.toThrow('personal wallet')
  client.getBalance.mockResolvedValueOnce(quote.amount * 10n ** 12n)
  await expect(sendArcDeposit(wallet, quote, false, () => {}, record)).rejects.toThrow('gas')
  const approval = jest.fn().mockResolvedValue(orderId)
  client.readContract.mockResolvedValueOnce(0n)
  record.mockClear()
  await sendArcDeposit({ ...wallet, sendTransaction: approval }, quote, true, () => {}, record)
  expect(record).not.toHaveBeenCalled()
  expect(approval).toHaveBeenCalledWith(
    expect.objectContaining({
      to: ARC_USDC_ADDRESS,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.spender, quote.amount] }),
    }),
  )
})

it('uses the signed Arc Relay order for its deposit and the request ID for tracking', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 23, 19))
  const api = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => relayFixture } as Response)
  const quote = await quoteArcDeposit('Relay', owner, 8453, 100_000_000n)
  expect(JSON.parse(String(api.mock.calls[0][1]?.body))).toMatchObject({
    user: owner,
    recipient: owner,
    refundTo: owner,
    amount: '100000000',
    originChainId: 5042,
    destinationChainId: 8453,
  })
  expect(quote.id).toBe(relayFixture.requestId)
  expect(quote.minimum.toString()).toBe(relayFixture.details.currencyOut.minimumAmount)
  expect(RELAY_DEPOSIT.decodeFunctionData('depositErc20', quote.data)[3]).toBe(relayFixture.protocol.v2.orderId)
  await expect(quoteArcDeposit('Relay', owner, 137, 100_000_000n)).rejects.toThrow()
})
