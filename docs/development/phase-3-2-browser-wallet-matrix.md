# Phase 3.2 — Browser × wallet matrix

**Date:** 2026-05-20
**Approach:** Playwright Chromium for the browsers we can automate;
documented expectations for Firefox/Safari/wallet matrix that need
manual real-device testing.

## Automated (Playwright Chromium)

| Surface | Status | Notes |
|---|---|---|
| Landing page load | ✅ | 200 response, bundle hash `index-DfqhU1eY.js` |
| `/swap` deep-link with valid tokens | ✅ | UI renders, "Select a token" placeholder, "Connect Wallet" CTA |
| `/swap` with invalid token address | ⚠️ | 16 console errors, UI still renders gracefully (Phase 3.4 F2) |
| `/swap` on unsupported chain (999999) | ⚠️ | Falls back to OP silently (Phase 3.4 F3) |
| `/limit` deep-link | ✅ | Tutorial overlay, then form |
| `/advanced` (TWAP) deep-link | ✅ | Renders correctly |
| Top-of-modal Etherscan link | ✅ | Allow-list fix deployed (DisplayLink.tsx) |
| `/api/intent` POST sequential | ✅ | 90% success @ 1.4s/req (Phase 3.8) |
| `/api/intent` POST concurrent | ❌ | 100% 504 @ concurrency 20 (Phase 3.8 F1) |

Console-error baseline: ~17 errors per fresh load from contract
resolution before wallet connects. Cosmetic, Sentry breadcrumb noise.
Fixable with conditional render guards (Phase 3.4 F1).

## NOT automated — needs real device / real wallet

| Browser | Wallet | Why manual | Priority |
|---|---|---|---|
| Chrome | MetaMask | Done by user (Phase 3.1 swap) ✅ | — |
| Chrome | WalletConnect | QR-flow + mobile-bridge needs phone | LOW pre-launch |
| Chrome | Rabby | Rabby provider works similar to MM | MED pre-launch |
| Firefox | MetaMask | wagmi+Firefox quirks (cookie isolation) | MED pre-launch |
| Firefox | WalletConnect | Same | LOW |
| Safari | MetaMask | iOS deep-link from Safari to MM mobile app | HIGH (mobile traffic) |
| Safari | WalletConnect | Standard QR flow | HIGH |
| Mobile Chrome (Android) | MetaMask mobile | In-app browser deep-link | HIGH |
| Mobile Safari (iOS) | Rainbow / MM mobile | Universal Link bridge | HIGH |

The HIGH-priority matrix items are mobile entries because:
1. Ophis.fi gets organic mobile traffic from Twitter/Telegram link clicks
2. Per Phase 3.3 F2, the FE has touch-target sizing issues that ONLY
   manifest in real touch (not Playwright)
3. iOS Safari has known WKWebView+Web3 issues that affect WalletConnect
   bridging

## Recommendation

The MED+HIGH matrix items should be checked by a real human on real
devices before public launch. Estimate: 1 person, 90 minutes, with
small amounts of test ETH in 3 wallets across 2 devices.

For now: ship Chrome+MetaMask as the validated path (Phase 3.1 proved
it). Document the rest as "supported on best-effort basis until tested."
