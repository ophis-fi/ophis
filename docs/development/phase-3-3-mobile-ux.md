# Phase 3.3 — Mobile UX validation

**Date:** 2026-05-20
**Tooling:** Playwright viewport simulation, no real touch input
**Viewports tested:** iPhone SE (375×667), iPhone 14 Pro (393×852), iPad (768×1024)

## Findings

### F1 — Frontend defaults to chain 1 (Ethereum) on landing (LOW)

The homepage at `https://ophis.fi` defaults to chain 1 (Ethereum mainnet),
and the "Skip to manual swap" link goes to `#/1/swap/_/_`. On page load,
the FE fires 13+ requests to `https://mainnet.infura.io/v3/<public-key>`
(public CoW-frontend default Infura key, not ours).

**Impact:**
- Privacy: Infura logs every visitor's IP + intended swap parameters
- Sovereignty: defeats the "we run our own infra" pitch — landing
  traffic is Infura-dependent
- Centralization: if Infura goes down, the landing page degrades

**Fix shape:** default the landing chain to 10 (Optimism, our actual
mainnet) AND swap the fallback RPC from the public Infura key to our
own eRPC at `https://optimism-mainnet.ophis.fi` (where the orderbook
already lives). Single-line config change in `cowSdk.ts` / chain
default + RPC mapping.

**Priority:** ship before public launch (privacy + sovereignty
correctness). Not urgent for closed beta.

### F2 — Touch-target sizes below platform minimums on mobile (LOW)

On the `/swap` page at 393px wide:

| Element | Size (px) | Apple HIG min | Material min | Status |
|---|---|---|---|---|
| Token-amount textbox | 155 × **35** | 44 | 48 | ❌ below both |
| "Select a token" button | 148 × **35** | 44 | 48 | ❌ below both |
| Flip-arrow swap-direction | 32 × 32 | 44 | 48 | ❌ below both |
| "Connect Wallet" CTA | 337 × **58** | 44 | 48 | ✅ above both |
| Top-right "Open Swap →" | 133 × 38 | 44 | 48 | ❌ height below |
| Footer Home/Swap/Docs/GitHub | ~35-41 × 15 | 44 | 48 | ❌ way below |
| Mobile "Skip to manual swap" | 124 × 18 | 44 | 48 | ❌ way below |

The dominant inputs (textbox, token-select button) are 35px tall — about
80% of Apple HIG's 44pt minimum. Result: fat-finger mistypes on iPhone,
especially in dim light or one-handed use. Footer links at 15px are
essentially unusable on touch devices.

**Fix shape:** bulk-bump min-height on `.token-input`, `.token-select`,
`.swap-arrow`, and `.footer-link` to 44px (use Tailwind `min-h-11` or
equivalent). Adds maybe 30px total vertical scroll on mobile, much
better tap reliability.

**Priority:** ship before public launch. Easy 1-hour fix.

### F3 — Chip carousel offscreen-left at small viewports (cosmetic)

On iPhone SE 375×667, the example-swap-intent chip carousel renders the
first chip ("Swap 100 USDC for ETH on Base") starting at x=-221 (well
offscreen left). The chips are auto-scrolling in a marquee pattern, so
this is just the snapshot frame — but on a static screenshot it looks
broken.

**Impact:** none functionally (the carousel auto-scrolls into view).
But product screenshots / marketing captures might show the broken
frame.

**Fix shape:** add `transform: translateX(0)` initial state in the
marquee CSS or use `prefers-reduced-motion: no-preference` to gate the
animation. Or just leave it — auto-resolves within 2s of page load.

## Out of scope for this run

- **Touch interaction:** Playwright doesn't simulate real iOS/Android
  touch (no pinch-zoom, no swipe ergonomics). Need real device testing.
- **WalletConnect QR flow:** needs a real wallet to validate the
  modal sizing + QR readability at viewport widths < 380px.
- **Mobile Safari quirks:** specifically the `100vh` viewport bug and
  the WKWebView gesture conflicts on the swap arrow. Need real Safari.

## Recommendation

F1 (Infura default) is the most-important pre-launch fix — privacy /
sovereignty narrative. F2 (touch targets) is the second-priority — UX
friction on mobile. F3 is cosmetic.

All three are deferred to the FE/branding/design sprint since they
require coordinated styling + chain-default decisions that should be
made together with the broader rebrand.
