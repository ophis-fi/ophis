import { EnrichedOrder, OrderKind, SupportedChainId } from '@cowprotocol/cow-sdk'
import { BridgeStatus, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { Interface } from '@ethersproject/abi'

import sample from './fixtures/usdc-base-optimism.json'
import { RELAY_DAPP_ID, RELAY_DEPOSIT, relayDepository } from './relay.constants'
import { relayBridgingParams } from './relayHistory.service'

import { getEthFlowContractAddresses } from '../common'

const SHED = '0x2222222222222222222222222222222222222222'
const SETTLEMENT = '0x4444444444444444444444444444444444444444'
const UID = `0x${'55'.repeat(56)}`
const TX = `0x${'66'.repeat(32)}`
const ABI = new Interface([
  ...RELAY_DEPOSIT.fragments,
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const request: QuoteBridgeRequest = {
  kind: OrderKind.SELL,
  account: sample.request.user,
  amount: BigInt(sample.request.amount),
  sellTokenChainId: SupportedChainId.BASE,
  sellTokenAddress: sample.request.originCurrency,
  sellTokenDecimals: 6,
  buyTokenChainId: 10 as SupportedChainId,
  buyTokenAddress: sample.request.destinationCurrency,
  buyTokenDecimals: 6,
}
const order = (): EnrichedOrder =>
  ({
    owner: request.account,
    receiver: SHED,
    buyToken: request.sellTokenAddress,
    uid: UID,
    fullAppData: JSON.stringify({
      metadata: {
        bridging: {
          providerId: RELAY_DAPP_ID,
          destinationChainId: '10',
          destinationTokenAddress: request.buyTokenAddress,
          quoteBody: JSON.stringify({
            request: { ...request, amount: String(request.amount) },
            relay: sample.response,
          }),
        },
      },
    }),
  }) as EnrichedOrder
const log = (address: string, event: string, args: unknown[]): { address: string; topics: string[]; data: string } => ({
  address,
  ...ABI.encodeEventLog(ABI.getEvent(event), args),
})
const logs = (): ReturnType<typeof log>[] => [
  log(SETTLEMENT, 'Trade', [request.account, SETTLEMENT, request.sellTokenAddress, 1, 10_000_000, 0, UID]),
  log(request.sellTokenAddress, 'Transfer', [SETTLEMENT, SHED, 10_000_000]),
  log(request.sellTokenAddress, 'Transfer', [SHED, relayDepository(8453), 10_000_000]),
  log(relayDepository(8453), 'RelayErc20Deposit', [
    SHED,
    request.sellTokenAddress,
    10_000_000,
    sample.response.protocol.v2.orderId,
  ]),
]
const mockReceipt = { status: 1, logs: logs() }
jest.mock('../networks', () => ({
  ...jest.requireActual('../networks'),
  getRpcProvider: () => ({ getTransactionReceipt: async () => mockReceipt }),
}))
const status = jest.fn(async () => ({ status: BridgeStatus.EXECUTED }))
const read = (savedOrder = order()): ReturnType<typeof relayBridgingParams> =>
  relayBridgingParams(status, SupportedChainId.BASE, savedOrder, TX, { [SupportedChainId.BASE]: SETTLEMENT })

beforeEach(() => {
  mockReceipt.status = 1
  mockReceipt.logs = logs()
  status.mockClear()
})

it('binds a confirmed deposit to its own traded order and polls the request id, not the order id', async () => {
  const result = await read()
  expect(result?.params).toMatchObject({
    bridgingId: sample.response.requestId,
    inputAmount: 10_000_000n,
    inputTokenAddress: request.sellTokenAddress,
    outputAmount: BigInt(sample.response.details.currencyOut.minimumAmount),
    recipient: request.account,
    destinationChainId: 10,
  })
  expect(status).toHaveBeenCalledWith(sample.response.requestId, 8453)
})

it.each(['prod', 'staging'] as const)('resolves the authenticated %s EthFlow sender', async (env) => {
  const savedOrder = order()
  savedOrder.owner = getEthFlowContractAddresses(env, SupportedChainId.BASE)
  savedOrder.onchainOrderData = { sender: request.account }
  expect((await read(savedOrder))?.params.owner).toBe(request.account)
})

it.each(['missingSender', 'wrongSender', 'forgedSender'])(
  'rejects mismatched EthFlow ownership: %s',
  async (mutation) => {
    const savedOrder = order()
    savedOrder.owner = getEthFlowContractAddresses('prod', SupportedChainId.BASE)
    if (mutation === 'wrongSender') savedOrder.onchainOrderData = { sender: SETTLEMENT }
    if (mutation === 'forgedSender') {
      savedOrder.owner = SETTLEMENT
      savedOrder.onchainOrderData = { sender: request.account }
    }
    await expect(read(savedOrder)).rejects.toThrow()
    expect(status).not.toHaveBeenCalled()
  },
)

it.each([
  'failedReceipt',
  'missingTrade',
  'wrongDepository',
  'missingPull',
  'fakeDepositor',
  'wrongAmount',
  'beforePayout',
])('does not credit %s as this order’s bridge', async (mutation) => {
  const mutations: Record<string, () => void> = {
    failedReceipt: () => {
      mockReceipt.status = 0
    },
    missingTrade: () => {
      mockReceipt.logs.shift()
    },
    wrongDepository: () => {
      mockReceipt.logs[3].address = SETTLEMENT
    },
    missingPull: () => {
      mockReceipt.logs.splice(2, 1)
    },
    fakeDepositor: () => {
      mockReceipt.logs[2] = log(request.sellTokenAddress, 'Transfer', [SETTLEMENT, relayDepository(8453), 10_000_000])
    },
    wrongAmount: () => {
      mockReceipt.logs[3] = log(relayDepository(8453), 'RelayErc20Deposit', [
        SHED,
        request.sellTokenAddress,
        1,
        sample.response.protocol.v2.orderId,
      ])
    },
    beforePayout: () => {
      mockReceipt.logs.reverse()
    },
  }
  mutations[mutation]()
  expect(await read()).toBeNull()
  expect(status).not.toHaveBeenCalled()
})
