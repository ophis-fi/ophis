# Ophis swap widget: embed examples

Drop a live, MEV-protected, intent-based swap into any site. Orders route
through the Ophis solver network across 11 chains and carry the Ophis partner
fee. The widget is a thin, Ophis-branded layer over the battle-tested CoW
Protocol widget.

Full guide: **[docs.ophis.fi/widget](https://docs.ophis.fi/widget)**

## Run the demo

```bash
# from this folder: any static server works
npx serve .
# open http://localhost:3000/index.html
```

`index.html` embeds the real widget against `https://swap.ophis.fi`.

## Pick an integration

| File | Stack | Notes |
| --- | --- | --- |
| `snippets/react.tsx` | React | **Recommended.** `@ophis/widget-react` injects `baseUrl`, `appCode` and pins the fee recipient. |
| `snippets/nextjs.tsx` | Next.js (App Router) | Same, loaded client-only (`ssr: false`). |
| `snippets/vanilla.html` | Plain JS | `@cowprotocol/widget-lib` pointed at `swap.ophis.fi`. Full control, no framework. |
| `snippets/iframe.html` | Raw iframe | Zero deps, quickest preview. No fee/theme/events; use the above for production. |

## Config you'll actually set

| Field | Value | Why |
| --- | --- | --- |
| `baseUrl` | `https://swap.ophis.fi` | The Ophis host. (React wrapper sets this for you.) |
| `appCode` | `"MyDapp-via-Ophis"` | Tags your volume in order appData. Use your own. |
| `partnerFee.bps` | `10` (0.10%) | Stable–stable pairs are reduced server-side. |
| `partnerFee.recipient` | `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` | The Ophis Safe. Pinned by the React wrapper; on Optimism it is allowlist-enforced on-chain. |
| `tradeType`, `sell`, `buy`, `theme`, `chainId` | your choice | Full [CoW widget params](https://www.npmjs.com/package/@cowprotocol/widget-lib) pass through. |

## Chains

Ethereum · Optimism *(self-hosted settlement)* · Base · Arbitrum · Polygon ·
Avalanche · BNB Chain · Gnosis · Linea · Plasma · Ink. The widget picks the host
per chain automatically (Optimism settles on the Ophis orderbook; the rest route
via `api.cow.fi`).

## One requirement on the host

The widget loads `swap.ophis.fi` in an iframe on **your** origin, so the host
must allow third-party framing (CSP `frame-ancestors *`, no `X-Frame-Options:
SAMEORIGIN`). Ophis ships this. If you self-host an Ophis fork, set it too, or the
iframe is blocked.

Clickjacking is mitigated structurally: every fund-moving action (connect,
approve, sign) completes in a wallet-rendered popup **outside** the frame, so a
malicious host page cannot forge a confirmation.
