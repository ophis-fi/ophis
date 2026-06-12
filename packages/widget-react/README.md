# @ophis/widget-react

Embed the [Ophis](https://ophis.fi) swap widget in any React app. A thin,
Ophis-branded wrapper over [`@cowprotocol/widget-react`](https://www.npmjs.com/package/@cowprotocol/widget-react)
that defaults the iframe host to `swap.ophis.fi`, tags orders with the Ophis
`appCode`, and pins the CIP-75 partner fee to the Ophis Safe.

## Install

```bash
npm install @ophis/widget-react react react-dom
```

Requires **React 19** (this wrapper accepts `^19.1.2`, i.e. React 19 at 19.1.2 or
newer). Note the wrapped `@cowprotocol/widget-react@3.1.1` declares an *exact*
`react: 19.1.2` peer, so under strict peer-dependency handling only React 19.1.2
avoids a peer warning from that upstream package; any other 19.x (above or below)
can warn. Default npm/yarn treat this as a warning, not an install failure.

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

## Footprint

This package is a thin wrapper, but installing it pulls in `@cowprotocol/widget-react`
and its full transitive tree (the CoW SDK plus an IPFS/libp2p/multiformats stack and
an HTTP client). If your bundle is size-sensitive, the iframe embed only needs the
URL: use [`@cowprotocol/widget-lib`](https://www.npmjs.com/package/@cowprotocol/widget-lib)
directly (see [Vanilla JS](#vanilla-js--no-react) above) for a lighter footprint.

## License

[GPL-3.0-or-later](./LICENSE)
