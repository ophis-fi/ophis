---
id: widget
title: Embeddable swap widget
description: Embed the Ophis swap app in a React or JavaScript site.
sidebar_label: Swap widget
sidebar_position: 3
---

# Embeddable swap widget

Embed the Ophis swap app so users can trade from your site.

<Cards>
<Card icon="app-window" title="Embedded swaps">Load swap.ophis.fi in an iframe on your page.</Card>
<Card icon="wallet" title="Wallet connection">Pass an EIP-1193 provider to connect a wallet inside the widget.</Card>
<Card icon="receipt" title="Fee configuration">The widget applies the Ophis fee policy for the selected chain.</Card>
</Cards>

## Install for React {/* #react-recommended */}

<Steps>

1. **Install the package.** Add the widget and its React dependencies.

   ```bash
   npm install @ophis/widget-react react react-dom
   ```

2. **Render the widget.** Add `OphisWidget` to your page.

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

3. **Connect a wallet.** Pass an EIP-1193 injected wallet as `provider`.

</Steps>

The wrapper supplies `baseUrl` and `appCode` automatically.

## Install for JavaScript {/* #vanilla-js */}

<Steps>

1. **Install the library.** Use the underlying CoW Protocol widget library.

   ```bash
   npm install @cowprotocol/widget-lib
   ```

2. **Create the widget.** Add a container with the ID `ophis-widget`, then point the widget at Ophis.

   ```ts
   import { createCowSwapWidget } from '@cowprotocol/widget-lib';

   const container = document.getElementById('ophis-widget')!;
   createCowSwapWidget(container, {
     params: {
       baseUrl: 'https://swap.ophis.fi', // the Ophis host
       appCode: 'ophis',
       tradeType: 'swap',
       width: '450px',
       height: '640px',
     },
   });
   ```

</Steps>

:::tip[Use the default fee policy]

Leave `partnerFee` unset to use Ophis's base and price-improvement fees. An explicit `partnerFee` uses that volume-fee `bps` value in place of the default policy.

:::

## Widget configuration {/* #configuration */}

| Field | Default via `@ophis/widget-react` | Purpose |
| --- | --- | --- |
| `baseUrl` | `https://swap.ophis.fi` | Iframe host; override for a self-hosted or staging Ophis. |
| `appCode` | `ophis` | Tags orders in appData. |
| `partnerFee` | Unset | The iframe applies the complete Ophis fee policy. |
| `partnerFee.recipient` | Ophis Safe when overridden | Pinned by the React wrapper. |
| `chainId`, `sell`, `buy`, `theme`, `tokenLists` | Upstream defaults | [CoW widget parameters](https://www.npmjs.com/package/@cowprotocol/widget-lib) pass through. |

## Choose a theme {/* #theming */}

Set `theme` to `'light'`, `'dark'` or a full palette object. The default uses Ophis app styling.

## Run the demo {/* #live-demo--copy-paste-snippets */}

<Steps>

1. **Open the examples.** Use [examples/widget-embed/](https://github.com/ophis-fi/ophis/tree/main/examples/widget-embed) for React, Next.js, vanilla JS and raw iframe snippets.
2. **Start the demo.** Run `npx serve .` in that folder and open `index.html`.

</Steps>

## Hosting and settlement {/* #notes */}

| Chains | Orderbook |
| --- | --- |
| Optimism, Unichain, Robinhood Chain, Arc | Ophis self-hosted orderbooks |
| Ethereum, Base, Arbitrum, Polygon, BNB, Gnosis, Avalanche, Linea, Plasma, Ink | `api.cow.fi` |

The widget selects the orderbook for the chosen chain. Use the standalone app for direct Circle bridging.

A self-hosted iframe host must allow third-party framing: set CSP `frame-ancestors *` and omit `X-Frame-Options: SAMEORIGIN`. The hosted app already allows framing. Users sign fund-moving actions in a wallet popup outside the iframe.

| License | Value |
| --- | --- |
| Widget | GPL-3.0 |

## Next

<Cards>
<Card icon="receipt" title="Fees" href="/fees">Read the fee policy for each settlement path.</Card>
<Card icon="network" title="Networks and routes" href="/networks-assets">Check network and bridge support.</Card>
<Card icon="bot" title="Agent integration" href="/ai-agents">Build a programmatic integration with MCP or the SDK.</Card>
</Cards>
