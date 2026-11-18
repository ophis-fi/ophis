# Frontend OP Mainnet Wiring — Security/Correctness Review

**Branch:** `feat/frontend-op-mainnet` (7 commits, +195/-50 across 18 files)
**Plan:** `/Users/scep/greg/docs/spec-2-spec-3/frontend-op-mainnet-wiring-plan.md`
**Reviewers:** Claude Opus 4.7 (synthesis) + gpt-5 codex (delegated findings)
**Date:** 2026-05-14

---

## TL;DR — Verdict

**APPROVE_WITH_CONDITIONS**

No CRITICAL or HIGH severity issues. Address verification clean. All four key Ophis-deployed addresses (Settlement, VaultRelayer, OP WETH, USDC native on OP) match infrastructure ground-truth byte-for-byte. The zero-address EthFlow sentinel is inert in practice because the SDK-side `ETH_FLOW_ADDRESSES[10]` is undefined and `useEthFlowContext` gates execution. Orderbook URL routing is correct. Domain regex is safe.

Two MEDIUM issues need to be addressed before merging the production deploy:
1. **TWAP UI is reachable on OP and silently no-ops** — the plan called for an explicit kill-switch that was not implemented.
2. **Default token lists for chain 10 are dead code** — the `tokensList.json` `"10"` entry never reaches users because `DEFAULT_TOKENS_LISTS` is built via `mapSupportedNetworks` which iterates only the SDK enum.

Three LOW issues are merge-eligible with follow-up:
3. Orderbook env-var override can silently retarget OP chain orders.
4. `REACT_APP_NETWORK_URL_10` secret gets bundled into the public client — fine for a free public RPC, dangerous if upgraded to a paid endpoint without re-architecting.
5. Coinbase wallet connector still uses unpatched `ALL_SUPPORTED_CHAIN_IDS` — OP users may not be able to connect with Coinbase Wallet.

---

## Address verification (manual cross-check vs ground truth)

Cross-checked every hex literal added by the diff against `/Users/scep/greg/infra/optimism-mainnet/configs/orderbook.toml`, `/Users/scep/greg/infra/optimism-mainnet/configs/driver.toml.tmpl`, and `/Users/scep/greg/infra/optimism-mainnet/configs/autopilot.toml`.

| Symbol | Ground truth | Diff value | Match |
|---|---|---|---|
| Settlement | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | `0x310784c7FCE12d578dA6f53460777bAc9718B859` (cowProtocolContracts.ts:18) | OK |
| VaultRelayer | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` (cowProtocolContracts.ts:19) | OK |
| WETH (OP) | `0x4200000000000000000000000000000000000006` | `0x4200000000000000000000000000000000000006` (nativeAndWrappedTokens.ts) | OK |
| USDC native (OP) | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `USDC_OPTIMISM` import (already in common-const) — not re-defined in this diff | OK (imported, not redefined) |
| Orderbook URL | `https://optimism-mainnet.ophis.fi` | `https://optimism-mainnet.ophis.fi` (cowSdk.ts) | OK |

No digit, case, or checksum mismatch in any changed literal.

EthFlow zero-address sentinel `0x0000000000000000000000000000000000000000` for chain 10 — verified as **intentional sentinel**, not a typo'd contract address.

---

## Codex findings (verbatim)

> **MEDIUM** — `useTwapFormState.ts:16`, `advancedOrders/const.ts:4`, `useTwapOrderCreationContext.ts:30`, `useCreateTwapOrder.tsx:113`
> TWAP was supposed to be disabled on chain 10, but there is no OP guard. The route remains reachable, `useTwapFormState()` returns no "unsupported chain" state, while `COMPOSABLE_COW_ADDRESS` / `CURRENT_BLOCK_FACTORY_ADDRESS` are still built only from SDK-supported chains. On OP, `useTwapOrderCreationContext()` becomes `null`, and `useCreateTwapOrder()` just returns at line 113.
> *Breakage*: a user can open `/#/10/advanced`, review a TWAP, click "Place TWAP order", and get a silent no-op instead of a blocked UI or explicit error.
> *Fix*: implement the planned OP kill-switch at the UI boundary (`return null` / unsupported state from `useTwapFormState()` for `chainId===10`), and hide OP TWAP entry points/banners.

> **MEDIUM** — `tokensLists.ts:10`, `tokenListsStateAtom.ts:20`, `tokenListsStateAtom.ts:34`, `tokenListsStateAtom.ts:62`
> The new `"10"` entry in `tokensList.json` is dead code. `DEFAULT_TOKENS_LISTS` is still created with `mapSupportedNetworks(...)`, so OP is omitted. In curated-list mode, `UNISWAP_TOKEN_LIST_URL` also has no chain-10 entry, so OP builds `{ source: undefined }`.
> *Breakage*: normal OP users get no default token lists at all; US/geoblocked users (curated mode) can end up with an undefined curated-list source, which can break token-list loading entirely.
> *Fix*: extend these maps explicitly with `[10 as unknown as SupportedChainId]` entries, or replace them with the same extended chain set used elsewhere. Add tests for `DEFAULT_TOKENS_LISTS[10]` and curated-mode behavior on OP.

> **LOW** — `cowSdk.ts:45`
> `REACT_APP_ORDER_BOOK_URLS` is merged on top of the hardcoded Ophis map via `{ ...OPHIS_ORDERBOOK_BASE_URLS, ...envBaseUrls }`, so any env entry for `"10"` silently overrides `https://optimism-mainnet.ophis.fi`. There is no validation of allowed host per chain.
> *Breakage*: a deploy typo or stale env JSON can silently route OP quotes/orders to the wrong backend. That is especially risky here because chainId + settlement are part of signing correctness.
> *Fix*: in production, pin chain 10 to the Ophis host or validate overrides against an allowlist before constructing `OrderBookApi`.

> **LOW** — `.github/workflows/cloudflare-deploy.yml:61`
> `REACT_APP_NETWORK_URL_10` is sourced from GitHub `secrets`, but every `REACT_APP_*` value is bundled into the client. If this "secret" contains an authenticated/private RPC URL, it will be exposed publicly.
> *Breakage*: an operator stores a paid RPC endpoint/API key as a secret expecting secrecy; the built JS leaks it to every user.
> *Fix*: use a repo variable or plain public value for client RPC URLs, or ensure the secret is intentionally keyless/public. The workflow only runs on `push` to `main` and `workflow_dispatch`, so there is no PR-secret exfil path.

> **LOW** — `coinbase.connector.ts:93`
> Coinbase Wallet still initializes with `ALL_SUPPORTED_CHAIN_IDS`, which excludes OP, even though other wallet paths were patched.
> *Breakage*: Coinbase users may still fail to connect/switch to Optimism despite OP being shown as supported elsewhere.
> *Fix*: pass the same extended chain list used in wagmi / `isChainAllowed` / WalletConnect.

> **NOTES**
> - Address cross-check passed for every changed literal: settlement, vault relayer, WETH, orderbook URL. No digit/checksum mismatch.
> - No path found that sends native ETH to `0x0000...0000`. The zero-address sentinel is only threaded through quote params at `useQuoteParams.ts:114`; actual ETH-flow execution still resolves the contract through `getEthFlowContractAddresses()` at `useContract.ts:115` and hard-checks the address before signing at `ethFlow/index.ts:83`.
> - Production domain regex is safe: matches `ophis.fi`, doesn't match `localhost:3000`, doesn't match `evil.ophis.fi.attacker.com` because of the trailing `$`. `swap.ophis.fi` is covered by `.*\.ophis\.fi`.
> - Token lists are not signature-verified client-side. Trust = host/TLS boundary of `static.optimism.io` and `files.cow.fi`, not an on-client signature check.

---

## My judgment on each finding

### M1 — TWAP silent no-op on OP

**Confirmed.** I verified by reading:
- `apps/frontend/apps/cowswap-frontend/src/modules/advancedOrders/const.ts:4` — `COMPOSABLE_COW_ADDRESS` is `mapAddressToSupportedNetworks(composableCowAddress)`. The SDK's `mapAddressToSupportedNetworks` iterates SDK's `ALL_SUPPORTED_CHAIN_IDS` (no 10), so `COMPOSABLE_COW_ADDRESS[10]` is `undefined`.
- `useComposableCowContract` reads from `COMPOSABLE_COW_ADDRESS[chainId]` → undefined → `useContract` returns `{ contract: null }`.
- `useTwapOrderCreationContext` requires a truthy `composableCowContract` → returns `null`.
- `useCreateTwapOrder` early-returns when context is null.

The plan section 4 explicitly mentioned this and called for "Disable TWAP UI for chainId=10 as a Phase 4 safety measure (return `null` from `useTwapFormState`)". That disable is **not in the diff**.

**Real severity: MEDIUM**, not HIGH. No funds at risk — the silent no-op is a UX dead end, not a settlement attack. But it's a broken-promise UI: user clicks button, nothing happens, no error toast. Bad UX, not exploitable.

**Recommendation:** Add an explicit OP guard in `useTwapFormState.ts` before merge. One-liner:
```ts
if (chainId === 10) return TwapFormState.NOT_SUPPORTED // or similar existing enum value
```
This converts the silent no-op into an explicit "TWAP not available on Optimism" banner. **Required before merge.**

### M2 — Token list dead code

**Confirmed.** Verified `DEFAULT_TOKENS_LISTS` at `tokensLists.ts:10` uses `mapSupportedNetworks`, so the new `"10"` JSON entry never reaches `DEFAULT_TOKENS_LISTS[10]`.

Failure modes split by `useCuratedListOnly` flag:
- **Curated-mode-off (default):** `DEFAULT_TOKENS_LISTS[10] || []` → empty array → user sees only the manually-added favorites (WETH + USDC). Suboptimal but workable.
- **Curated-mode-on (US/geoblocked users):** `UNISWAP_TOKEN_LIST_URL[10]` is `undefined` → fetch fails. Token list fetcher may crash or show empty.

**Real severity: MEDIUM**. No security impact, but user-visible breakage for any user beyond WETH/USDC.

**Recommendation:** Two-line fix in `tokensLists.ts`:
```ts
export const DEFAULT_TOKENS_LISTS: ListsSourcesByNetwork = {
  ...mapSupportedNetworks((chainId) => tokensList[chainId]),
  [10 as unknown as SupportedChainId]: tokensList['10'],
}
```
And add a `[10]: ...` entry to `UNISWAP_TOKEN_LIST_URL` (use the same Optimism CoinGecko URL or skip if no Uniswap list exists for OP). **Required before merge.**

### L1 — Orderbook env override risk

**Real but low impact.** The current `REACT_APP_ORDER_BOOK_URLS` env var is not set in the production CI workflow (verified: not in `.github/workflows/cloudflare-deploy.yml`). So in production the merge behavior reduces to `OPHIS_ORDERBOOK_BASE_URLS` only.

Risk surface: an operator who later adds `REACT_APP_ORDER_BOOK_URLS` to CI, fat-fingers chain 10's URL → orders for OP get sent to the wrong host → user signs an order that the wrong backend either rejects (silent failure) or relays under a different appCode (revenue leak, not theft).

**Recommendation:** Defensive but optional. Could lock `OPHIS_ORDERBOOK_BASE_URLS[10]` post-merge to prevent override. Acceptable as-is for the current deployment because the env var is unset in CI.

### L2 — REACT_APP_NETWORK_URL_10 bundling

**Real but currently benign.** Any `REACT_APP_*` var is exposed in the built JS (this is standard CRA behavior). For a free public RPC like `optimism-rpc.publicnode.com`, leakage is fine. For a paid Alchemy/QuickNode URL with API key embedded, it's a leak.

The current default value in `networks.ts` is the public publicnode URL — safe. The CI workflow says "Add REACT_APP_NETWORK_URL_10 to GitHub repo secrets to override" — if the secret is set to a public URL, no harm. If it's set to a private paid URL with key, **the key will be in the bundle**.

**Recommendation:** Add a comment to `cloudflare-deploy.yml:61` warning that any value set here ends up in the client bundle. Treat as INFO if the team is aware. The plan doesn't explicitly state which kind of RPC will live in that secret.

### L3 — Coinbase connector missing OP

**Confirmed.** `coinbase.connector.ts:93` reads `appChainIds: ALL_SUPPORTED_CHAIN_IDS` from the SDK, which excludes 10. Other wallet paths (`isChainAllowed.ts`, `walletConnectV2.tsx`, `wagmi/config.ts`) were extended; Coinbase was not.

Practical impact: Coinbase Wallet users on OP may see "unsupported chain" errors when connecting. Other wallets (MetaMask injected, WalletConnect, Safe) work fine.

**Recommendation:** Easy fix — append `10` to the array passed to Coinbase SDK. Suggest including in pre-merge cleanup but acceptable as a follow-up patch if Coinbase Wallet is not a high-priority connector for the launch.

---

## My own additional observations beyond codex's findings

**INFO-1** — EIP-712 signing path is correct. `COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[10] = 0x310784c7FCE12d578dA6f53460777bAc9718B859` matches the deployed Ophis Settlement on OP. The frontend casts chainId to `SupportedChainId` for type purposes but the runtime chainId remains `10`, which is what gets put into the EIP-712 domain. Signatures will verify against the deployed contract.

**INFO-2** — `isBarnBackendEnv` and prod URL on OP. In `cowSdk.ts`, `OrderBookApi` is instantiated with `env: isBarnBackendEnv ? 'staging' : 'prod'` AND a full `baseUrls` map that includes chain 10 → Ophis prod URL. This is fine because the SDK's `OrderBookApi.fetch()` uses `baseUrls[chainId]` directly when provided, ignoring `env`. Verified in SDK source.

**INFO-3** — `getCurrentChainIdFromUrl.ts:25` change reads `chainId in SupportedChainId || chainId === 10`. Note this is a SQLi-pattern-style trap that other reviewers might flag — `in` on a TS enum works because TS enums get reverse-mapped at runtime; the second clause is the OP escape hatch. Safe.

**INFO-4** — Plan section 5 noted `REACT_APP_DOMAIN_REGEX_PRODUCTION` was set. Codex verified the regex `^(ophis\.fi|.*\.ophis\.fi|greg-etm\.pages\.dev)$` is safe against subdomain attacks (trailing `$` anchor prevents `evil.ophis.fi.attacker.com` matches) and doesn't match `localhost:3000`. Confirmed.

**INFO-5** — The `as unknown as SupportedChainId` casts add a maintenance burden but no runtime risk. Each cast is local and the JS-level chainId remains `10`. The risk is that future SDK upgrades may add Optimism to the `SupportedChainId` enum natively, at which point these casts become redundant / shadowing.

---

## Required actions before merging into `docs/spec-2-spec-3`

**Required (blocks merge):**
1. **Fix M1 — TWAP kill-switch.** Add explicit OP guard in `useTwapFormState.ts` so the UI shows an explicit "TWAP not available on Optimism" state instead of a silent no-op button.
2. **Fix M2 — Token list wiring.** Extend `DEFAULT_TOKENS_LISTS` and `UNISWAP_TOKEN_LIST_URL` to include chain 10 entries, otherwise the `tokensList.json` `"10"` entry is dead code.

**Recommended (can merge with follow-up issue):**
3. **Fix L3 — Coinbase connector.** Append `10` to `appChainIds` in `coinbase.connector.ts`.
4. **Document L2 — RPC secret bundling.** Add a comment in `cloudflare-deploy.yml` noting that any value of `REACT_APP_NETWORK_URL_10` ends up in the public bundle.

**Optional (defensive hardening, not required):**
5. **L1 — Orderbook override allowlist.** If operationally worth the complexity, validate `REACT_APP_ORDER_BOOK_URLS` overrides against an allowlist in `cowSdk.ts`.

---

## Files reviewed in detail

- `/Users/scep/greg/apps/frontend/libs/common-utils/src/cowProtocolContracts.ts`
- `/Users/scep/greg/apps/frontend/libs/common-utils/src/getCurrentChainIdFromUrl.ts`
- `/Users/scep/greg/apps/frontend/libs/common-utils/src/isSupportedChainId.ts`
- `/Users/scep/greg/apps/frontend/libs/common-utils/src/environments.ts`
- `/Users/scep/greg/apps/frontend/libs/common-const/src/chainInfo.ts`
- `/Users/scep/greg/apps/frontend/libs/common-const/src/common.ts`
- `/Users/scep/greg/apps/frontend/libs/common-const/src/nativeAndWrappedTokens.ts`
- `/Users/scep/greg/apps/frontend/libs/common-const/src/networks.ts`
- `/Users/scep/greg/apps/frontend/libs/tokens/src/const/defaultFavoriteTokens.ts`
- `/Users/scep/greg/apps/frontend/libs/tokens/src/const/tokensList.json`
- `/Users/scep/greg/apps/frontend/libs/tokens/src/const/tokensLists.ts`
- `/Users/scep/greg/apps/frontend/libs/tokens/src/state/tokenLists/tokenListsStateAtom.ts`
- `/Users/scep/greg/apps/frontend/libs/wallet/src/wagmi/config.ts`
- `/Users/scep/greg/apps/frontend/libs/wallet/src/web3-react/connection/walletConnectV2.tsx`
- `/Users/scep/greg/apps/frontend/libs/wallet/src/web3-react/utils/isChainAllowed.ts`
- `/Users/scep/greg/apps/frontend/libs/wallet/src/web3-react/utils/switchChain.ts`
- `/Users/scep/greg/apps/frontend/libs/wallet/src/web3-react/connectors/Coinbase/coinbase.connector.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/cowSdk.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/common/hooks/useContract.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/ethFlow/services/ethFlow/index.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/ethFlow/hooks/useEthFlowContext.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/tradeQuote/hooks/useQuoteParams.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/twap/hooks/useTwapFormState.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/twap/hooks/useTwapOrderCreationContext.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/advancedOrders/const.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/tradeFlow/services/safeBundleFlow/safeBundleEthFlow.ts`
- `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/orderProgressBar/constants.ts`
- `/Users/scep/greg/.github/workflows/cloudflare-deploy.yml`
- `/Users/scep/greg/infra/optimism-mainnet/configs/orderbook.toml` (ground truth)
- `/Users/scep/greg/infra/optimism-mainnet/configs/driver.toml.tmpl` (ground truth)
- `/Users/scep/greg/apps/frontend/node_modules/.pnpm/@cowprotocol+sdk-trading@2.0.2.../dist/index.mjs` (SDK behavior verification)
