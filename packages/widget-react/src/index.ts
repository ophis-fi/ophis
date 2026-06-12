// Ophis-branded React swap widget.
export { OphisWidget, type OphisWidgetProps } from './OphisWidget.js';

export {
  withOphisDefaults,
  OPHIS_WIDGET_BASE_URL,
  OPHIS_WIDGET_APP_CODE,
  OPHIS_WIDGET_PARTNER_FEE,
} from './defaults.js';

// Re-export the upstream types + the raw component so integrators can build
// custom configs or escape-hatch to the unbranded widget without a second
// dependency. (Types only; the Ophis defaults live in OphisWidget.)
export type {
  CowSwapWidgetParams,
  CowSwapWidgetProps,
  CowSwapWidgetHandler,
  CowSwapTheme,
  TradeType,
  PartnerFee,
  EthereumProvider,
} from '@cowprotocol/widget-react';
export { CowSwapWidget } from '@cowprotocol/widget-react';
