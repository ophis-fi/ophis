---
id: widget
title: Embeddable swap widget
description: Drop the Ophis swap widget into any site or React app. Orders route through the Ophis solver and partner fee with zero extra config.
sidebar_label: Swap widget
sidebar_position: 3
---

# Embeddable swap widget

Let your users swap without leaving your site. The Ophis widget is an iframe of
[swap.ophis.fi](https://swap.ophis.fi). Orders route through the Ophis solver
and carry the Ophis partner fee automatically. It is a thin, Ophis-branded layer
over the battle-tested CoW Protocol widget.

## React (recommended)

```bash
npm install @ophis/widget-react react react-dom
```

```tsx
import { OphisWidget } from '@ophis/widget-react';

export function Swap() {
  return (
    <OphisWidget
      params={{ tradeType: 'swap', width: '450px', height: '640px' }}
      onReady={() => console.log('Ophis widget ready')}
    />
  );
}
```

Pass a `provider` (an EIP-1193 injected wallet) to let users connect inside the
widget. `baseUrl`, `appCode`, and the partner fee are injected for you.

## Vanilla JS

No React? Use the underlying library and point it at Ophis:

```bash
npm install @cowprotocol/widget-lib @ophis/sdk
```

```ts
import { createCowSwapWidget } from '@cowprotocol/widget-lib';
import { buildOphisAppDataPartnerFee } from '@ophis/sdk';

const container = document.getElementById('ophis-widget')!;
const fee = buildOphisAppDataPartnerFee(10); // { volumeBps, recipient } on OP

createCowSwapWidget(container, {
  params: {
    baseUrl: 'https://swap.ophis.fi', // the Ophis host
    appCode: 'Ophis',
    tradeType: 'swap',
    width: '450px',
    height: '640px',
    partnerFee: fee ? { bps: fee.volumeBps, recipient: fee.recipient } : undefined,
  },
});
```

> The widget's `partnerFee` uses `bps`; the SDK exposes the same number as
> `volumeBps`. Map `volumeBps` to `bps` as shown.

## Configuration

| Field | Default (via `@ophis/widget-react`) | Notes |
| --- | --- | --- |
| `baseUrl` | `https://swap.ophis.fi` | The iframe host. Override for a self-hosted/staging Ophis. |
| `appCode` | `Ophis` | Tags orders in appData. Set your own e.g. `"MyDapp-via-Ophis"`. |
| `partnerFee.bps` | `10` (0.10%) | Same-chain stable pairs are reduced server-side. |
| `partnerFee.recipient` | Ophis Safe | Always pinned by the React wrapper. |
| `chainId`, `sell`, `buy`, `theme`, `tokenLists` | upstream defaults | Full [CoW widget params](https://www.npmjs.com/package/@cowprotocol/widget-lib) pass through. |

## Theming

Pass a `theme` (`'light'` or `'dark'`) or a full palette object: see the
upstream widget docs. The widget inherits the Ophis app styling by default.

## Live demo + copy-paste snippets

A runnable demo and one-file snippets for React, Next.js, vanilla JS and a raw
iframe live in the repo at
[`examples/widget-embed/`](https://github.com/ophis-fi/ophis/tree/main/examples/widget-embed).
Run `npx serve .` in that folder and open `index.html` to see the widget
embedded against a third-party origin.

## Notes

- The widget is GPL-3.0, like the rest of Ophis.
- Optimism orders settle on the Ophis self-hosted orderbook; the CoW-hosted
  chains (Ethereum, Base, Arbitrum, Polygon, BNB, Gnosis, Avalanche, Linea,
  Plasma, Ink) route via `api.cow.fi`. Host selection is handled inside the
  widget app — 11 chains in total.
- **Self-hosting an Ophis fork?** The host must allow third-party framing — CSP
  `frame-ancestors *` and no `X-Frame-Options: SAMEORIGIN` — or integrators'
  iframes are blocked. (`swap.ophis.fi` already ships this.) Clickjacking is
  mitigated structurally: every fund-moving action signs in a wallet popup
  outside the frame.
- For programmatic / agent integrations (no iframe), use the
  [AI agent guide](./ai-agents.md) and [`@ophis/sdk`](https://www.npmjs.com/package/@ophis/sdk) directly.
