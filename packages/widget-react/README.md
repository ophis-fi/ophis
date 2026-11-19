# @ophis/widget-react

Embed the [Ophis](https://ophis.fi) swap widget in a React app. It defaults the
iframe host to `swap.ophis.fi`, tags orders with the Ophis `appCode`, and applies
the Ophis partner-fee policy.

## Install

```bash
npm install @ophis/widget-react react@19.1.2 react-dom@19.1.2
```

Requires **React and React DOM exactly 19.1.2**, matching the underlying widget's
peer requirements. Other versions can fail dependency resolution. For an app
using another React version, use the iframe integration described below.

## Use it

```tsx
import { OphisWidget } from '@ophis/widget-react';

export function Swap() {
  return (
    <OphisWidget
      params={{
        tradeType: 'swap',
        width: '450px',
        height: '640px',
        // chainId, sell, buy, theme, tokenLists, etc. all pass through.
      }}
      onReady={() => console.log('Ophis widget ready')}
    />
  );
}
```

That's it. No `baseUrl`, no `appCode`, no fee wiring needed: the wrapper injects
them. Pass a `provider` for an injected wallet.

## What the wrapper sets for you

| Field | Default | Override? |
| --- | --- | --- |
| `baseUrl` | `https://swap.ophis.fi` | Yes (e.g. a staging host) |
| `appCode` | `ophis` | Yes |
| `partnerFee` | Omitted so the Ophis iframe applies the complete all-chain policy | Yes; an explicit override is honored |
| `partnerFee.recipient` | Ophis Safe `0x858f0F5e...CeF8` when overridden | No, always pinned |

Use the exported `OphisWidgetProps` type for the supported component properties.

## Vanilla JS / no React?

Use the Ophis iframe integration without installing this React package.
See the [integration guide](https://docs.ophis.fi/widget) for the embed URL,
configuration and provider integration.

## Footprint

The React package includes a trading SDK, networking utilities and their
dependencies. For a smaller integration, use the iframe embed described above.

## License

[GPL-3.0-or-later](./LICENSE)
