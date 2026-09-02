import { CowWidgetEvents, OnBridgingSuccessPayload } from '@cowprotocol/events'

import { trackGa4Event } from 'ophis/analytics/track'
import { WIDGET_EVENT_EMITTER } from 'widgetEventEmitter'

import { OrderStatusEvents } from '../events/events'
import { ORDER_STATUS_EVENT_EMITTER } from '../events/orderStatusEventEmitter'

export function emitBridgingSuccessEvent(payload: OnBridgingSuccessPayload): void {
  const { sourceChainId, destinationChainId } = payload.bridgingParams

  trackGa4Event('order_filled', {
    chainId: sourceChainId,
    destinationChainId,
    isBridge: true,
  })

  WIDGET_EVENT_EMITTER.emit(CowWidgetEvents.ON_BRIDGING_SUCCESS, payload)
  ORDER_STATUS_EVENT_EMITTER.emit(OrderStatusEvents.ON_BRIDGING_SUCCESS, payload)
}
