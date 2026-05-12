# Spec 4 — Frontend wiring: route Ophis chains through Ophis backends

> Sequel to Spec 1/2/3. Spec 4 teaches `ophis.fi` (the cowswap fork) to route orders for chains where Ophis has self-hosted a backend (`optimism-sepolia.ophis.fi`, `megaeth-testnet.ophis.fi`, `megaeth.ophis.fi`, `optimism.ophis.fi`) instead of `api.cow.fi`.

## Summary

Today the frontend only knows the 10 CoW-supported chains (MAINNET, GNOSIS, SEPOLIA, ARBITRUM_ONE, BASE, POLYGON, AVALANCHE, BNB, LINEA, PLASMA, INK). Spec 4 adds:

1. **Chain enum extension** for Ophis-hosted chains: `OPTIMISM_SEPOLIA (11155420)`, `MEGAETH_TESTNET (6343)`, `MEGAETH_MAINNET (4326)`, `OPTIMISM (10)`.
2. **Per-chain orderbook URL override** via the existing `REACT_APP_ORDER_BOOK_URLS` env var (already plumbed in `cowSdk.ts:30`).
3. **Chain metadata** (display name, icon, native token, block explorer URL, public RPC) for each new chain.
4. **Network selector UI** lists the new chains visibly so users can pick them.
5. **RPC provider configuration** so the frontend can read chain state (balances, allowances, etc.) on the Ophis chains.

## Goals & non-goals

### Goals
- A user lands on `ophis.fi`, picks "MegaETH" from the network selector, swaps, and the order is routed to `megaeth.ophis.fi` (not `api.cow.fi`).
- Same UX as the current CoW-chain swap flow — no special-case prompts, no manual URL pasting.
- Chain icons + names visible and branded for the new networks.
- Block-explorer links on successful settlement resolve to the correct chain explorer (megaexplorer.xyz, optimistic.etherscan.io, etc.).

### Non-goals
- Adding new tokens to the token-list for the new chains — that's a token-list update, scoped to a separate task.
- Mobile UI polish beyond what's already shipped.
- Wallet-connect updates for the new chains — wallet-connect's chain metadata is third-party.
- Frontend-side rebate display — already shipping via `rebates.ophis.fi`.

## Why this matters

Spec 1-3 stand up the backends, but until Spec 4 ships, nobody but the smoke-test scripts can use them. Real user traffic flows through the frontend, which routes through `api.cow.fi` for every chain → traffic never hits our backends.

After Spec 4: any user on `ophis.fi` switching to MegaETH or Optimism *automatically* routes through Ophis's backend, gets the partner-fee shape applied, and we capture the price-improvement spread.

## Architecture

### Today (broken for Ophis chains)
```
  user → ophis.fi → cowswap-frontend → @cowprotocol/cow-sdk OrderBookApi
                                            ↓
                              api.cow.fi/<chain-slug>/v1/orders
                                            ↓
                                  hardcoded chain map
                                  doesn't include OP/MegaETH/etc.
                                            ↓
                                     ERROR / 404 / NaN
```

### After Spec 4
```
  user → ophis.fi → cowswap-frontend → OrderBookApi
                                            ↓
                            REACT_APP_ORDER_BOOK_URLS env override:
                            {
                              "11155420": "https://optimism-sepolia.ophis.fi",
                              "6343":     "https://megaeth-testnet.ophis.fi",
                              "4326":     "https://megaeth.ophis.fi",
                              "10":       "https://optimism.ophis.fi",
                              ...rest fall back to api.cow.fi for the 10 CoW chains
                            }
                                            ↓
                                Ophis backend (Spec 1/2/3)
                                            ↓
                                Settled on chain by driver
```

`REACT_APP_ORDER_BOOK_URLS` is already wired in `apps/frontend/apps/cowswap-frontend/src/cowSdk.ts:30` — it parses the JSON env var and passes it as `baseUrls` to `OrderBookApi`. The plumbing exists; only the deploy-workflow env value and the chain enum need to change.

## Components / changes

### 1. SupportedChainId enum extension

`@cowprotocol/cow-sdk` (vendored via subtree in `apps/frontend/libs/cow-sdk`) defines `SupportedChainId`. We need to add new entries.

**Decision:** Don't fork cow-sdk. Use **TypeScript module augmentation** in `apps/frontend/apps/cowswap-frontend/src/greg/supportedChainIds.ts` to extend the enum without modifying the vendored library. This survives `git subtree pull` cleanly.

```typescript
// apps/cowswap-frontend/src/greg/supportedChainIds.ts
declare module '@cowprotocol/cow-sdk' {
  export enum SupportedChainId {
    OPTIMISM_SEPOLIA = 11155420,
    MEGAETH_TESTNET = 6343,
    MEGAETH_MAINNET = 4326,
    OPTIMISM = 10,
  }
}

export const GREG_CHAIN_IDS = [
  11155420, 6343, 4326, 10,
] as const;
```

The augmentation only adds enum *members* to the type — at runtime, cow-sdk reads from a separate constants map that we need to extend at runtime.

**Alternative considered + rejected:** Fork the cow-sdk vendored library. Easier short-term but creates a divergence on every subtree pull. Reject.

### 2. Chain metadata

`apps/frontend/libs/common-const/src/common.ts` and similar files have per-chain config (icon path, native token, etc.). Most of these guard on `chainId in SupportedChainId` — extending the enum cascades through.

For chain-specific values:
- Block explorer URL: `megaexplorer.xyz`, `sepolia-optimism.etherscan.io`, `optimistic.etherscan.io`
- Native currency: ETH for all (Optimism/MegaETH/MegaETH testnet all use ETH-equivalent gas tokens)
- Public RPC URL: same as `infra/<chain>/.env` `node-url` values for the backend, but the FRONTEND uses these for reading state (not solving). Free public RPCs are fine for read-only frontend traffic.

### 3. Orderbook URL injection

Update `.github/workflows/cloudflare-deploy.yml`:

```yaml
env:
  REACT_APP_ORDER_BOOK_URLS: |
    {
      "11155420": "https://optimism-sepolia.ophis.fi",
      "6343":     "https://megaeth-testnet.ophis.fi",
      "4326":     "https://megaeth.ophis.fi",
      "10":       "https://optimism.ophis.fi"
    }
```

(Multiline string YAML → single-line JSON inside the build via `JSON.parse` already happens in `cowSdk.ts`.)

The cow-sdk's `OrderBookApi` constructor treats `baseUrls` as a partial override: any chainId in this map uses our URL; any chainId NOT in this map falls through to the default `api.cow.fi/<chain-slug>` route. So the 10 CoW chains keep working unchanged.

### 4. Network selector UI

`apps/frontend/apps/cowswap-frontend/src/modules/networks/` (and similar) renders the chain switcher. After enum extension, the switcher auto-includes the new chains IF they're in the runtime constants. We need to add them to the displayed list explicitly.

UX note: Use the official chain logos (MegaETH's blue M, Optimism's red O). Place Ophis-hosted chains in a "BETA" or "EARLY ACCESS" group visually to set expectations.

### 5. RPC provider config

`@cowprotocol/common-const`'s `getRpcProvider(chainId)` returns the public RPC URL for each chain. We need to extend this to return:
- `https://sepolia.optimism.io` (or public alternative) for OPTIMISM_SEPOLIA
- `https://carrot.megaeth.com/rpc` for MEGAETH_TESTNET
- `https://mainnet.megaeth.com/rpc` for MEGAETH_MAINNET
- `https://mainnet.optimism.io` (or public alternative) for OPTIMISM

Frontend RPC pressure is much lighter than the CoW driver's (no continuous block stream), so free public RPCs work even when they don't for the backend.

## Risk & rollback

| Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|
| Module augmentation breaks at TS build time | Low | Frontend doesn't compile | Test in dev before push. Augmentation is a well-supported TS pattern. | Fall back to forking cow-sdk type defs (creates a single subtree-divergence file). |
| User's wallet doesn't support the new chains | High initially | User must add network manually | Provide a one-click "add MegaETH to wallet" button via `wallet_addEthereumChain` RPC. | None — wallet support is third-party. |
| Public RPC for OP/MegaETH degrades | Medium | Frontend can't read state | Frontend stays usable for the CoW chains; the new ones get a clear "RPC unavailable" toast. | Switch to a different public RPC. |
| `api.cow.fi` returns a 404 for an unknown chainId that our override misses | Low | Order submission fails silently | Make sure the chainId guard in cow-sdk gives a clear error. | Add the chainId to our override map. |
| Ophis backend goes down → user trades blocked | Medium | Trading impossible on that chain | Subscribe to alerts; CoW Protocol staging server doesn't help (it's CoW's, not ours). | Manually disable the chain in the selector via env. |
| Chain switching mid-trade leaves UI in inconsistent state | Medium | Bad UX | Existing cowswap handles chain-switch already (resets quote, etc.). | None — bug fixes in implementation. |

## Cost

| Item | Cost |
|---|---|
| Engineering | ~3 days subagent-driven |
| Recurring infra | $0 (no new infra) |
| Public RPC reliance for frontend reads | $0 (free public RPCs) |
| Chain icon sourcing | $0 (use official assets or commission via Fiverr if needed) |
| Wallet-add-chain UX | $0 (RPC-level standard) |

## Success metrics + done-checklist

### Functional
- [ ] On `ophis.fi`, the network selector shows Optimism, OP Sepolia, MegaETH mainnet, MegaETH testnet
- [ ] Selecting MegaETH mainnet → entering a swap → signing → backend receives the order at `megaeth.ophis.fi/api/v1/orders`
- [ ] Settlement tx visible in user's history with correct chain context
- [ ] Block-explorer link for the settled tx resolves to `megaexplorer.xyz/tx/...`

### Type-safety + build
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` produces a working bundle
- [ ] Module augmentation doesn't break upstream subtree pull (test: simulate a pull, resolve any conflict)

### CI
- [ ] CF Pages build succeeds with `REACT_APP_ORDER_BOOK_URLS` set
- [ ] Bundle size delta < 10 KB (chain metadata is small)

### Repo state
- [ ] `apps/frontend/.greg-divergences.md` updated with the new files
- [ ] `infra/cloudflare/ophis-chain-backends.md` notes the frontend-to-backend mapping
- [ ] `project_greg.md` Phase 4 section reflects Spec 4 ship

### Negative checks
- [ ] No user can submit an order to api.cow.fi for OP/MegaETH chains (the override prevents this)
- [ ] No new env-vars committed to the repo (only set in CI)
- [ ] No additional bundle weight from cow-sdk fork (we're augmenting, not forking)

## Open questions for implementation plan

1. **Chain icon sourcing.** Both Optimism and MegaETH have public logos with usage rights — confirm we can use them. Decide on SVG vs PNG, and where they live in the asset tree.
2. **Wallet auto-add UX.** When the user picks a chain their wallet doesn't have, do we prompt with `wallet_addEthereumChain`? Yes — but confirm UX copy.
3. **"BETA" badge.** UI design for the badge (color, position, copy: "BETA" vs "EARLY ACCESS" vs none). Talk to Clement for visual direction.
4. **Public RPC choice.** For frontend reads we can use *any* free public RPC. Should we pick the cheapest/fastest, or align with backend's RPC for consistency? Recommendation: use backend's `node-url` so behavior is consistent.
5. **Order discovery for the user's history.** The frontend asks the orderbook for past orders. With per-chain override, this just works — confirm in implementation.
6. **Existing CoW-chain MEV receipt flow.** Should the Ophis chains have MEV-proof receipts too? The MEV receipt module already exists; just needs to plumb through the Ophis backend URLs. Optional in Spec 4 scope.

Implementation plan should resolve 1-6 inline.

## Dependencies on other specs

| Other spec | What we need from it | Status |
|---|---|---|
| Spec 1 | testnet backends live | ✓ shipped 2026-05-12 |
| Spec 2 | OP mainnet backend live | ⏳ waiting on RPC-host decision + funding |
| Spec 3 | MegaETH mainnet backend live | ⏳ waiting on deployer funding |

Spec 4 CAN ship for Optimism Sepolia + MegaETH testnet only, providing a fully working frontend experience on testnets without requiring Spec 2/3 first. We can extend the override map for mainnet chains incrementally as 2 + 3 land.

Recommended ship sequence:
1. **Spec 4a (this spec, testnet subset)** — wire OP Sepolia + MegaETH testnet immediately
2. **Spec 4b (post-Spec-3)** — extend to MegaETH mainnet
3. **Spec 4c (post-Spec-2)** — extend to OP mainnet
