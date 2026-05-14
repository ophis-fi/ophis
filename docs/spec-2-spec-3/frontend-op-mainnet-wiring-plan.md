# Ophis Frontend — OP Mainnet Wiring Plan

**Date:** 2026-05-14
**Scope:** Promote `AdditionalTargetChainId.OPTIMISM` (10) to a full `SupportedChainId` in the Ophis frontend fork.

---

## The Root Blocker — SDK Boundary

The CoW SDK v9 (`@cowprotocol/cow-sdk@9.0.2`) hard-codes Optimism at chain ID 10 as `AdditionalTargetChainId.OPTIMISM`. The `SupportedChainId` enum has 11 members (1, 56, 100, 137, 8453, 9745, 42161, 43114, 57073, 59144, 11155111) — OP is absent.

**We cannot add OP to `SupportedChainId` without forking the SDK package** — which would break on every upstream `pnpm upgrade`. The correct approach: keep OP in `AdditionalTargetChainId` at SDK level and introduce local "extended supported chains" at the frontend level, overriding every consumer individually via `[10 as unknown as SupportedChainId]` casts.

The SDK's `OrderBookApi.fetch()` does `this.getApiBaseUrls(context)[chainId]` — passing `{ 10: "https://optimism-mainnet.ophis.fi" }` in `baseUrls` works at runtime even though the TypeScript type says `Record<SupportedChainId, string>` — use `as unknown as ApiBaseUrls`.

---

## Section 1 — Files That Need Editing (16 files, ~100 LoC)

### Tier 1: Chain-ID gates (must change for OP to be visible/selectable)

1. **`libs/common-const/src/chainInfo.ts`** — Add `10 as unknown as SupportedChainId` to `SORTED_CHAIN_IDS` (line 166) and `SORTED_DST_CHAIN_IDS` (line 184). `CHAIN_INFO` map entry already exists at line 154 under `AdditionalTargetChainId.OPTIMISM`.

2. **`libs/common-utils/src/isSupportedChainId.ts`** — Extend to include 10:
   ```typescript
   const OPHIS_EXTRA_CHAINS = new Set([10])
   export function isSupportedChainId(chainId: number | undefined): chainId is SupportedChainId {
     return typeof chainId === 'number' && (chainId in SupportedChainId || OPHIS_EXTRA_CHAINS.has(chainId))
   }
   ```

3. **`libs/common-utils/src/getCurrentChainIdFromUrl.ts`** — Line 25, allow `chainId === 10` so `/#/10/swap` doesn't redirect.

### Tier 2: RPC and wallet connectors

4. **`libs/common-const/src/networks.ts`** — Add OP entries to `RPC_URL_ENVS` and `DEFAULT_RPC_URL`. Default RPC: `https://optimism-rpc.publicnode.com`. Env var: `REACT_APP_NETWORK_URL_10`.

5. **`libs/wallet/src/wagmi/config.ts`** — Import `optimism` from `viem/chains`. Add to `SUPPORTED_CHAINS`. Build `ALL_CHAIN_IDS_FOR_WAGMI = [...SUPPORTED_CHAIN_IDS, 10]` and use it in `createConfig`.

6. **`libs/wallet/src/web3-react/utils/isChainAllowed.ts`** — Append 10 to each wallet's allowed list.

7. **`libs/wallet/src/web3-react/utils/switchChain.ts`** — Add `[10]: optimism.rpcUrls.default.http[0]` to `WALLET_RPC_SUGGESTION`.

8. **`libs/wallet/src/web3-react/connection/walletConnectV2.tsx`** — Add 10 to `optionalChains`.

### Tier 3: Contract address overrides

9. **`libs/common-utils/src/cowProtocolContracts.ts`** — Inject our deployed addresses:
   ```typescript
   COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS: {
     ...prodMap,
     [10]: '0x310784c7FCE12d578dA6f53460777bAc9718B859',
   }
   COW_PROTOCOL_VAULT_RELAYER_ADDRESS: {
     ...prodMap,
     [10]: '0x83847EaB41ad9ea43809ce71569eB2e9daF51830',
   }
   COW_PROTOCOL_ETH_FLOW_ADDRESS: { ..., [10]: '' }  // ETH Flow not deployed on OP
   ```

### Tier 4: OrderBook API

10. **`apps/cowswap-frontend/src/cowSdk.ts`** — Hardcode full `OPHIS_ORDERBOOK_BASE_URLS` map at `OrderBookApi` construction, including `10: 'https://optimism-mainnet.ophis.fi'` plus all upstream URLs for other chains.

### Tier 5: Token infrastructure

11. **`libs/common-const/src/nativeAndWrappedTokens.ts`** — Extend `WRAPPED_NATIVE_CURRENCIES` with OP WETH at `0x4200000000000000000000000000000000000006`.

12. **`libs/tokens/src/const/tokensList.json`** — Add `"10"` key with OP token list sources:
    ```json
    "10": [
      { "priority": 1, "enabledByDefault": true, "source": "https://static.optimism.io/optimism.tokenlist.json" },
      { "priority": 2, "enabledByDefault": true, "source": "https://files.cow.fi/token-lists/CoinGecko.10.json" }
    ]
    ```

13. **`libs/tokens/src/const/defaultFavoriteTokens.ts`** — Add OP entry with `USDC_OPTIMISM` + WETH.

### Tier 6: UI exhaustiveness

14. **`libs/common-const/src/common.ts`** — Extend `GAS_FEE_ENDPOINTS`, `GAS_API_KEYS`, `COW_CONTRACT_ADDRESS` (null for OP), `ETH_FLOW_SLIPPAGE_WARNING_THRESHOLD` with OP entries.

15. **`apps/cowswap-frontend/src/modules/orderProgressBar/constants.ts`** — Add `[10]: COW_SWAP_BENEFITS` to `CHAIN_SPECIFIC_BENEFITS`.

### Tier 7: CI

16. **`.github/workflows/cloudflare-deploy.yml`** — Add `REACT_APP_NETWORK_URL_10` and `REACT_APP_DOMAIN_REGEX_PRODUCTION` to `env:` block. Add `REACT_APP_NETWORK_URL_10` secret to GitHub repo settings.

---

## Section 2 — Risks

1. **`isSupportedChain()` from SDK** returns false for 10. Several call sites use it to branch; `ADDITIONAL_TARGET_CHAINS_MAP` already has OP metadata so branches will route correctly.

2. **`COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS` in `sdk-common`** has its own map without OP. The `isCoWSettlementContract()` helper will mark OP settlements as "unknown contract" in receipts. Cosmetic, not functional.

3. **ETH Flow absent on OP** — Setting empty string disables EthFlow UI. Verified safe.

4. **TWAP / ComposableCow not deployed on OP** — Disable TWAP UI for chainId=10 as a Phase 4 safety measure (return `null` from `useTwapFormState`).

5. **`REACT_APP_DOMAIN_REGEX_PRODUCTION`** doesn't include `ophis.fi`. Pre-existing bug — frontend runs as "local" env in production, defaults to staging endpoints. Must fix in cloudflare-deploy.yml env vars.

---

## Section 3 — Build / Test / Deploy

**Build:** `pnpm run build:cowswap` from `/Users/scep/greg/apps/frontend`. Builds to `build/cowswap/`.

**Typecheck:** `pnpm typecheck` — TypeScript exhaustiveness errors are the completeness oracle.

**Local dev:**
```bash
REACT_APP_ORDER_BOOK_URLS='{"10":"https://optimism-mainnet.ophis.fi"}' \
REACT_APP_NETWORK_URL_10='https://optimism-rpc.publicnode.com' \
pnpm run start:cowswap
```
Navigate to `http://localhost:3000/#/10/swap`.

**Deploy:** Cloudflare Pages via `.github/workflows/cloudflare-deploy.yml` on push to `main`. Production URL: `https://greg-etm.pages.dev` / `https://ophis.fi`.

---

## Implementation Sequence

**Phase A — Chain ID gates (unblock everything else)**
- chainInfo.ts SORTED_CHAIN_IDS + SORTED_DST_CHAIN_IDS
- isSupportedChainId.ts
- getCurrentChainIdFromUrl.ts

**Phase B — RPC and wallets**
- networks.ts
- wagmi/config.ts
- isChainAllowed.ts
- switchChain.ts
- walletConnectV2.tsx

**Phase C — Contracts**
- cowProtocolContracts.ts

**Phase D — Orderbook**
- cowSdk.ts (hardcode full baseUrls map)

**Phase E — Tokens**
- nativeAndWrappedTokens.ts
- tokensList.json
- defaultFavoriteTokens.ts

**Phase F — UI exhaustiveness + typecheck sweep**
- common.ts
- orderProgressBar/constants.ts
- run `pnpm typecheck` and fix remaining errors

**Phase G — CI**
- cloudflare-deploy.yml env vars
- GitHub repo secret REACT_APP_NETWORK_URL_10

---

## Total: 16 files, ~100 LoC, mechanical edits
