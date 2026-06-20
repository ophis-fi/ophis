// React embed — the recommended path.
//   npm install @ophis/widget-react react react-dom
//
// <OphisWidget> is a thin wrapper over @cowprotocol/widget-react that injects
// the Ophis defaults: baseUrl=swap.ophis.fi, appCode='ophis', and the CIP-75
// partner fee with the recipient PINNED to the Ophis Safe (you can tune the
// bps, but you cannot redirect the fee). Everything else passes straight
// through to the underlying CoW widget.
import { OphisWidget } from '@ophis/widget-react';

export function SwapWidget() {
  return (
    <OphisWidget
      params={{
        tradeType: 'swap',
        sell: { asset: 'ETH' },
        buy: { asset: 'USDC' },
        width: '450px',
        height: '640px',
        theme: 'dark',
        // Override appCode to attribute the volume you bring to your dapp.
        // baseUrl + the fee recipient are injected for you — omit them.
        appCode: 'MyDapp-via-Ophis',
      }}
      // Optional: hand the widget your app's connected wallet.
      // provider={injectedProvider}
      onReady={() => console.log('Ophis widget ready')}
    />
  );
}
