# Phase 3.5 — Quote types validation

**Date:** 2026-05-20
**Tooling:** Playwright on Chromium @ 1280×800

## Quote-type coverage on ophis.fi

The FE exposes three order types via top-of-page nav tabs:

| Tab | Route prefix | Order shape | Settlement path |
|---|---|---|---|
| **Swap** | `#/10/swap/<sell>/<buy>` | Market order, exact-in or exact-out | Standard CoW auction |
| **Limit** | `#/10/limit/<sell>/<buy>` | Limit order with user-set price | CoW limit-order pool, settles when price ≥ limit |
| **TWAP** | `#/10/advanced/<sell>/<buy>` | Time-weighted average price, multi-part | CoW programmable orders + ComposableCoW |

All three tabs are accessible via deep-link and via the in-app nav.
Chain selector + token selectors share state between tabs (selecting
USDC/WETH on Swap carries to Limit/TWAP).

## NLP intent → quote-type routing

The /api/intent function (Phase 3.8) parses natural-language to a
structured ParsedIntent. Looking at `intentToUrl.ts`:

- `"swap 100 USDC for ETH"` → orderKind=sell, exact-in → `#/10/swap/...`
- `"buy 1 ETH"` → orderKind=buy, exact-out → `#/10/swap/...?orderKind=buy`
- `"set up a DCA for 100 USDC → ETH"` (advanced) → `#/10/advanced/...`

Limit orders are NOT currently NLP-routable — the FE requires users to
manually switch to the Limit tab and set the limit price. Future
enhancement: NLP could match "swap X for Y at $Z" → limit-order.

## Playwright probes

### Swap exact-in (default)

```
URL: https://ophis.fi/#/10/swap/<USDC>/<WETH>?sellAmount=1&orderKind=sell
```

Rendered: standard swap form, sell input pre-filled with 1 USDC,
buy output computed from quote. URL query reflects state correctly.

### Swap exact-out

```
URL: https://ophis.fi/#/10/swap/<USDC>/<WETH>?buyAmount=0.001&orderKind=buy
```

Rendered: same form, but buy input pre-filled with 0.001 WETH, sell
input auto-computed from quote. URL query reflects orderKind=buy.

### Limit order

```
URL: https://ophis.fi/#/10/limit/<USDC>/<WETH>
```

Rendered: limit-order tutorial state ("Want to try out limit orders?
Get started!") with 6-bullet explainer. Confirms the route exists,
chain selector works, navigation between Swap/Limit/TWAP preserves
token pair.

### TWAP

```
URL: https://ophis.fi/#/10/advanced/<USDC>/<WETH>
```

Rendered: advanced order interface (DCA / TWAP setup). Same tab-
sharing behavior.

## Findings

### F1 (cosmetic) — 14 console errors on /limit deep-link (LOW)

Same baseline contract-resolution errors as Phase 3.4 F1 (without wallet,
chain-indexed contract addresses resolve to `0x0…0`). UI renders fine.

### F2 (UX) — limit order tutorial state defaults to overlay (LOW)

Even with a fully-specified deep-link (chain, sellToken, buyToken), the
limit-order page shows a tutorial overlay rather than going straight to
the form. A user clicking a "limit USDC→WETH" share link gets the
tutorial first, must dismiss to use it. Maybe intentional onboarding.

## Wallet-required testing deferred

Quote-type execution (signing limit orders, signing TWAP orders) needs
a real wallet. Out of scope for automated Playwright. Reserved for
manual smoke-test before public launch.

## Recommendation

All three quote-type routes work cosmetically. The actual settlement
of limit + TWAP orders has been exercised in the upstream CoW codebase
extensively (we're on a CoW Protocol fork, not a from-scratch impl).
Pre-launch validation: manually sign one limit order + one TWAP order
to confirm Ophis-fork compatibility, document in this file.
