import { OrderKind, SupportedChainId, type EnrichedOrder } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { type OnBridgingSuccessPayload } from '@cowprotocol/events'
import { type BridgeOrderDataSerialized, UiOrderType } from '@cowprotocol/types'

import { trackGa4Event } from 'ophis/analytics/track'

import { emitBridgingSuccessEvent } from './emitBridgingSuccessEvent'
import { emitFulfilledOrderEvent } from './emitFulfilledOrderEvent'
import { emitPostedOrderEvent } from './emitPostedOrderEvent'

jest.mock('ophis/analytics/track', () => ({ trackGa4Event: jest.fn() }))
jest.mock('widgetEventEmitter', () => ({ WIDGET_EVENT_EMITTER: { emit: jest.fn() } }))
jest.mock('../events/orderStatusEventEmitter', () => ({ ORDER_STATUS_EVENT_EMITTER: { emit: jest.fn() } }))

const OWNER = '0x0000000000000000000000000000000000000003'
const inputToken = new Token(SupportedChainId.MAINNET, '0x0000000000000000000000000000000000000001', 6, 'IN')
const outputToken = new Token(SupportedChainId.MAINNET, '0x0000000000000000000000000000000000000002', 18, 'OUT')
const bridgeOutputToken = new Token(SupportedChainId.BASE, '0x0000000000000000000000000000000000000002', 18, 'OUT')

describe('GA4 order lifecycle events', () => {
  beforeEach(() => jest.clearAllMocks())

  it('tracks a submitted order without identifiers or amounts', () => {
    emitPostedOrderEvent({
      chainId: SupportedChainId.MAINNET,
      id: 'private-order-uid',
      owner: OWNER,
      kind: OrderKind.SELL,
      uiOrderType: UiOrderType.SWAP,
      receiver: null,
      inputAmount: CurrencyAmount.fromRawAmount(inputToken, 1_000_000),
      outputAmount: CurrencyAmount.fromRawAmount(outputToken, 1),
    })

    expect(trackGa4Event).toHaveBeenCalledWith('order_submitted', {
      chainId: SupportedChainId.MAINNET,
      destinationChainId: SupportedChainId.MAINNET,
      isBridge: false,
      orderType: UiOrderType.SWAP,
      isEthFlow: false,
    })
  })

  it('preserves privacy-safe bridge classification on submission', () => {
    emitPostedOrderEvent({
      chainId: SupportedChainId.MAINNET,
      id: 'private-order-uid',
      owner: OWNER,
      kind: OrderKind.SELL,
      uiOrderType: UiOrderType.SWAP,
      receiver: null,
      inputAmount: CurrencyAmount.fromRawAmount(inputToken, 1_000_000),
      outputAmount: CurrencyAmount.fromRawAmount(bridgeOutputToken, 1),
    })

    expect(trackGa4Event).toHaveBeenCalledWith('order_submitted', {
      chainId: SupportedChainId.MAINNET,
      destinationChainId: SupportedChainId.BASE,
      isBridge: true,
      orderType: UiOrderType.SWAP,
      isEthFlow: false,
    })
  })

  it('tracks fulfillment without the order UID', () => {
    emitFulfilledOrderEvent(SupportedChainId.MAINNET, { uid: 'private-order-uid' } as EnrichedOrder)

    expect(trackGa4Event).toHaveBeenCalledWith('order_filled', {
      chainId: SupportedChainId.MAINNET,
      isBridge: false,
    })
  })

  it('does not count a bridge source-order fill as completed', () => {
    emitFulfilledOrderEvent(
      SupportedChainId.MAINNET,
      { uid: 'private-order-uid' } as EnrichedOrder,
      {} as BridgeOrderDataSerialized,
    )

    expect(trackGa4Event).not.toHaveBeenCalled()
  })

  it('tracks bridge fulfillment only from the executed bridging-success event', () => {
    emitBridgingSuccessEvent({
      bridgingParams: {
        sourceChainId: SupportedChainId.MAINNET,
        destinationChainId: SupportedChainId.BASE,
      },
    } as OnBridgingSuccessPayload)

    expect(trackGa4Event).toHaveBeenCalledWith('order_filled', {
      chainId: SupportedChainId.MAINNET,
      destinationChainId: SupportedChainId.BASE,
      isBridge: true,
    })
  })
})
