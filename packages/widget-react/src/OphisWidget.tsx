import { useMemo, type JSX } from 'react';
import { CowSwapWidget, type CowSwapWidgetProps } from '@cowprotocol/widget-react';

import { withOphisDefaults } from './defaults.js';

export type OphisWidgetProps = CowSwapWidgetProps;

/**
 * Ophis-branded swap widget. A thin wrapper over `<CowSwapWidget>` that injects
 * the Ophis defaults: iframe host `swap.ophis.fi`, `appCode: 'Ophis'`, and the
 * CIP-75 partner fee pinned to the Ophis Safe recipient. Everything else
 * (theme, tokens, provider, listeners, onReady) passes straight through.
 *
 * @example
 *   <OphisWidget
 *     params={{ tradeType: 'swap', width: '450px', height: '640px' }}
 *     provider={injectedProvider}
 *   />
 */
export function OphisWidget(props: OphisWidgetProps): JSX.Element {
  const { params, ...rest } = props;

  // Recompute only when the caller params actually change.
  const mergedParams = useMemo(() => withOphisDefaults(params), [params]);

  return <CowSwapWidget params={mergedParams} {...rest} />;
}
