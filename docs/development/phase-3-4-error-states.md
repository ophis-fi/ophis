# Phase 3.4 — Error state probes (2026-05-20)

Automated probes via Playwright against production ophis.fi (bundle
`index-DfqhU1eY.js`, deployed 2026-05-20 13:15 UTC).

All probes performed without a connected wallet (Playwright has no
injected EVM provider). Wallet-required error states (rejected sig,
expired quote post-sign) are out of scope for automated runs; they're
in the `Phase 3.5 / manual` track.

## Findings

### F1 — Baseline 17 console errors on every page load (LOW)

**Severity:** LOW (cosmetic, no UX impact, pollutes error budget)
**Reproduction:** Open `https://ophis.fi/#/10/swap/_/_` (or any valid
swap URL) with no wallet connected.

```
[ERROR] Failed to get contract Error:
        Invalid 'address' parameter '0x0000000000000000000000000000000000000000'.
        … × 17
```

**Root cause:** Contract resolution code (`useMemo`-wrapped contract
lookups for SWAP-Router / Multicall3 / VaultRelayer / etc.) fires
unconditionally on first render. Without a connected wallet, `chainId`
is `undefined`, the contract address map returns `undefined`, the
constructor defaults to `0x0…0` (zero address), the contract factory
throws.

**Impact:** None on functionality — the UI renders, "Connect Wallet" is
visible, tokens populate from the URL. But every visitor generates ~17
Sentry breadcrumbs / error captures, burning the project's error
budget. After wallet connects, the errors stop firing on subsequent
renders.

**Fix shape:** Guard the contract-lookup `useMemo` blocks with
`if (!chainId || !address) return null` before constructing. Standard
React Web3 hygiene — the upstream CoW codebase has the same pattern in
multiple places; we inherited it.

### F2 — Invalid token address in URL: 16 errors, UI graceful (LOW)

**Severity:** LOW (cosmetic; doesn't break the page)
**Reproduction:**
`https://ophis.fi/#/10/swap/0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF/0x4200000000000000000000000000000000000006`

Observed: 16 of the F1-shape errors. The token selector for the
invalid address gracefully shows "Select a token" placeholder. The
valid token (WETH) renders correctly. User can click the dropdown to
pick a real token.

**Also observed:** A bogus USD valuation appears for the user's typed
amount — `0.000469 WETH ≈ $1` (correct value would be ~$1.65). Price
oracle silently falls back to a stale or default price when the input
token can't be resolved.

**Fix shape:** Same as F1, plus token-resolution should return early
with a "couldn't resolve token from URL" UI banner so the user knows
something's off.

### F3 — Unsupported chain ID in URL: silent fallback (MEDIUM)

**Severity:** MEDIUM (silent failure of a user-facing surface)
**Reproduction:** `https://ophis.fi/#/999999/swap/_/_`

Observed:
- 16 of the F1-shape errors
- 1 clean wallet-level error:
  `Network switching error: Chain 999999 not supported for connector`
- UI silently falls back to Optimism in the header chain selector
- Token selectors are empty ("Select a token" × 2)
- No user-facing indication that the URL's chain is invalid

The user reading a shared/social link to a chain we don't support sees
an empty swap form with their target chain replaced by Optimism. They
have no way to know the URL was malformed.

**Fix shape:** When `chainId` from URL isn't in `SUPPORTED_CHAINS`,
either (a) redirect to `/#/10/swap/_/_` with a toast "chain
not supported, defaulting to Optimism", or (b) render a "this chain
isn't yet supported" error page with a link to the chain switcher.

## Findings deferred to Phase 3.5 (wallet-required)

These need a real MetaMask + funded wallet to probe:

- **Insufficient balance** — trigger amount > available USDC, observe
  UX of "insufficient balance" banner
- **Rejected signature** — sign-then-cancel in MetaMask, observe
  recovery flow
- **Expired quote** — let a quote sit > 60s, then click swap, observe
  re-quote prompt
- **Network mismatch** — wallet on chain X, URL on chain Y, observe
  switch-network UX
- **Allowance flow** — first-time token swap, observe approve →
  swap UX sequence
- **Wrong sell-token network** — try to sell a token that exists on a
  different chain than the wallet

## Recommendation

Ship none of these as blockers. F1+F2 are cosmetic and the pattern is
inherited from upstream CoW. F3 is the most user-visible — it's worth
1-2h of FE work pre-launch to add a "chain not supported" guard, but
doesn't block ship if we accept that malformed links silently default
to Optimism.

Higher-priority Phase 3 items still ahead:
- Phase 3.3 mobile UX (1h, already 50% done)
- Phase 3.5 quote types (needs real swaps, deferred)
- Phase 3.8 NLP load test (0.5h, fully automated)
- Phase 4 final audit re-sweep (2h)
