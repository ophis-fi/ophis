// Next.js (App Router) embed.
//
// The widget renders an <iframe> and uses window/postMessage, so it must run
// client-side only. Mark the file 'use client' AND load the component with a
// dynamic import that disables SSR, or Next will try to render it on the server
// and throw "window is not defined".
'use client';

import dynamic from 'next/dynamic';

const OphisWidget = dynamic(
  () => import('@ophis/widget-react').then((m) => m.OphisWidget),
  { ssr: false, loading: () => <div style={{ height: 640 }} /> },
);

export default function Swap() {
  return (
    <OphisWidget
      params={{
        tradeType: 'swap',
        sell: { asset: 'ETH' },
        buy: { asset: 'USDC' },
        width: '450px',
        height: '640px',
        theme: 'dark',
        appCode: 'MyDapp-via-Ophis',
      }}
    />
  );
}
