# NEAR Intents → Solana destination support

**Status:** ✅ ALREADY LIVE on production (verified empirically 2026-05-22)
⚠️ UX gap: Solana is **not discoverable** from the header network
selector — only from the buy-side token picker's "Select network"
panel. Clement flagged this as a brand task.
**Owner:** Clement
**Created:** 2026-05-22
**Linked task:** Clement's brand task #14 (Missing Solana in chain list per CoW's NEAR Intents integration)

---

## ⚠️ HISTORICAL NOTE

This spec was originally drafted on 2026-05-22 morning as a multi-day
epic estimating ~3-5 dev-days of FE work to wire NEAR Intents +
Solana. That estimate was **wrong** — the survey it was based on was
stale relative to current main. CoW Protocol's upstream
`@cowprotocol/cow-sdk` 4.0.2 (already pinned in this repo) ships
NEAR Intents support, and the Ophis fork inherited it without explicit
work. The retracted "epic" content is preserved below for historical
context; the actual present-day work is the much smaller UX
discoverability gap documented in the new "What's actually needed"
section.

---

## What's actually working today (verified live)

Empirically confirmed on https://ophis.fi 2026-05-22 via Playwright
inspection:

| Surface | Behavior |
|---|---|
| `bridgingSdk.ts:27` | `NearIntentsBridgeProvider({apiKey: process.env.REACT_APP_NEAR_API_KEY})` instantiated, added to `BridgingSdk.providers` |
| `chainInfo.ts` | `CHAIN_INFO[AdditionalTargetChainId.SOLANA]` populated from viem's `solana` chain metadata |
| Buy-side token picker → "Select network" panel | **Solana + Bitcoin both visible**, alongside EVM chains |
| Selecting Solana | Populates SPL tokens: **SOL, USDC (Solana), sUSDC** |
| `useAvailableTargetChains` hook | Skips Solana/Bitcoin only if `isSolBridgeEnabled` / `isBtcBridgeEnabled` feature-flags are false. In Ophis (no LaunchDarkly) the flags evidently default-enabled, so both appear. |

## What's NOT in place — the actual gap

| Surface | Current state |
|---|---|
| Header chain switcher (top-right) | EVM-only — Solana absent. |
| Landing page "Supported networks" advertising | No mention of Solana. |
| `/docs` Supported Networks card | EVM-only list (was 14 chains pre-cleanup, now 13). |
| `robots.txt` / `sitemap.xml` / JSON-LD | No SEO claim that Solana is supported. |

The semantic reason Solana is destination-only is correct (NEAR
Intents is a one-way EVM→Solana bridge), but the UX hides it: a user
who looks at the header chain list sees "10 EVM chains" and assumes
that's the full network list. The Solana option is buried two clicks
deep behind the buy-token picker.

## What's actually needed (the real "epic")

Much smaller than the original 10-subsystem estimate. Three
discoverability changes:

1. **Header network selector** — add a separate "Cross-chain
   destinations" section listing Solana + Bitcoin with a "destination
   only" badge. Selecting them should open the buy-side token picker
   pre-filtered to that chain. Estimate: ~half day.

2. **Landing/About copy** — mention NEAR Intents bridge support
   explicitly. E.g., on `/about`: "Trade from any EVM chain to Solana
   or Bitcoin via NEAR Intents — no extra wallet required." Estimate:
   ~30 min.

3. **`/docs` Supported Networks** — add a "Bridge destinations" card
   listing Solana + Bitcoin with the NEAR Intents reference. Update
   JSON-LD FAQ to mention them. Estimate: ~1h.

Total: ~1 dev-day, not 3-5.

## What's NOT changing

- The header chain switcher should remain EVM-only for SOURCE chains
  (where the wallet is connected). Solana destinations are output-only.
- No Solana wallet adapter (Phantom/Solflare) is needed — recipient
  address is just a base58 string the user pastes.
- No new RPC config required — NEAR Intents API does the routing.
- No new gas estimator — bridge fees flow through the existing quote
  pipeline.

## Architectural facts confirmed

- `NearIntentsBridgeProvider` is wired with `process.env.REACT_APP_NEAR_API_KEY`.
  In production this env var is **commented out** in `apps/cowswap-frontend/.env`
  — meaning the provider likely runs against a public-good NEAR Intents
  endpoint or anonymous-mode. If you ever see rate-limit issues, that's
  the lever to pull (acquire an API key, set in CF Pages env config).
- `isSolanaAddress` is imported in `legacyAddressUtils.ts:6` and used
  in the bridge recipient validation path. Address parsing works.
- Bitcoin support is symmetric to Solana — also live, also buried in
  the same picker, also worth surfacing.

## Acceptance criteria (REVISED — UX discoverability only)

- A user landing on ophis.fi can identify "this site lets me trade
  to Solana" from the header / landing copy / supported networks
  page without having to drill into the buy-side picker.
- A first-time visitor with no prior CoW Protocol context can find
  the NEAR Intents capability in under 30 seconds.

## Out of scope

- Solana → EVM (reverse direction). NEAR Intents one-way only.
- Solana → Solana within-chain. Not a thing in this bridge.
- Solana-native wallet connect. Out of scope; users sign EVM-side.

## References

- `apps/frontend/apps/cowswap-frontend/src/tradingSdk/bridgingSdk.ts:27`
- `apps/frontend/libs/common-const/src/chainInfo.ts` (search "SOLANA")
- `apps/frontend/libs/common-hooks/src/useAvailableTargetChains.ts`
- `apps/frontend/libs/common-utils/src/legacyAddressUtils.ts:6` (isSolanaAddress)
- Empirical verification: `/Users/scep/ophis-solana-tokens.png`,
  `/Users/scep/ophis-network-dropdown.png` (Playwright snapshots
  2026-05-22)
- CoW Protocol upstream docs: <https://docs.cow.fi/cow-protocol/concepts/cross-chain/near-intents>
