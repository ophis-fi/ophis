# @ophis/widget-react

Embed the [Ophis](https://ophis.fi) swap widget in any React app. A thin,
Ophis-branded wrapper over [`@cowprotocol/widget-react`](https://www.npmjs.com/package/@cowprotocol/widget-react)
that defaults the iframe host to `swap.ophis.fi`, tags orders with the Ophis
`appCode`, and pins the CIP-75 partner fee to the Ophis Safe.

## Install

```bash
npm install @ophis/widget-react react react-dom
```

Requires **React 19** (the wrapped `@cowprotocol/widget-react` pins React 19).

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
| `appCode` | `Ophis` | Yes |
| `partnerFee.bps` | `10` (0.10%) | Yes |
| `partnerFee.recipient` | Ophis Safe `0x858f0F5e...CeF8` | No, always pinned |

Everything else is the upstream `CowSwapWidgetParams` API. The raw
`CowSwapWidget` and all types are re-exported if you need the escape hatch.

## Vanilla JS / no React?

Use [`@cowprotocol/widget-lib`](https://www.npmjs.com/package/@cowprotocol/widget-lib)
directly and pass `baseUrl: 'https://swap.ophis.fi'`, `appCode: 'Ophis'`, and the
partner fee from [`@ophis/sdk`](https://www.npmjs.com/package/@ophis/sdk)
(`buildOphisAppDataPartnerFee`). See the [integration guide](https://docs.ophis.fi/widget).

## License

[GPL-3.0-or-later](./LICENSE)
