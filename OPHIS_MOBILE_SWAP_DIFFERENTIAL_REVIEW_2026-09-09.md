# Ophis mobile swap security differential review — 2026-09-09

## Decision

Local review and regression checks pass after remediation. Production release remains conditional on the release PR's security checks and production build. This document records an internal code review, including adversarial second-agent review; it is not an independent audit certification or a whole-protocol audit.

## Scope and baseline

Repository: ophis-fi/ophis. Feature branch: fix/mobile-swap-wallet. Mobile implementation commit: a0df7010c7bfe11e4de6cdedb58b12271d29bae1. Original development baseline was 40bb3e46; the implementation was rebased without conflicts onto production/main 12ee78b5a7bcf34fe30048dbcb64d5106be9d4d6 before this final review. Scope is the complete mobile UI/approval diff plus the security fixes and contracts tooling dependency patch in this PR. No Solidity source, deployed contract, backend authorization, recipient policy, fee policy, or production secret changed.

Reviewed all changed source files, their financial callers, related allowance/permit state, quote boundaries, signing flows and relevant history. Financial paths received line-by-line adversarial review. Presentation paths were inspected for security-sensitive controls, unsafe rendering, route scope, overlays, amount precision and accessibility. Static analysis scanned the changed production code and workflow. Appendix lists the reviewed change inventory.

## Threat model and invariants

Untrusted inputs include token metadata, refreshed quotes, wallet/provider state changes, amounts entered in the approval editor, persisted theme state, and host widget events. Trust boundaries are decimal input to integer base units, quote/allowance state to approval or permit, wallet chain to transaction submission, and concurrent requests to cached permit data.

- A chosen finite approval of 10 remains 10 in token base units; quote refresh must not silently raise it or convert it to unlimited.
- If the current order needs more than the available allowance and chosen cap, reject before signing or sending a bundled approval/presign.
- Unlimited approval is sent only through the explicit unlimited mode; its UI must say Unlimited.
- Approval token and chain must match the selected token; bind the submitted transaction to that chain even across asynchronous work.
- Concurrent permit requests with different amounts, spenders or nonces must not share authorization data.
- Mobile layout must retain the existing fee, slippage, recipient, price-impact and confirmation controls. Animations must not alter monetary values.

The cap controls new token approval. It does not revoke pre-existing allowances or promise an exact output amount from a market swap. DAI-like permits have boolean unlimited semantics and are not represented as finite EIP-2612 permits.

## Findings and remediation

| ID | Severity | Finding | Resolution and evidence |
| --- | --- | --- | --- |
| H1 | High | With cap 10, allowance 10 and a refreshed BUY order needing 11, allowance was checked against the cap and returned approval amount zero. Permit generation used `amount || DEFAULT_PERMIT_VALUE`, turning zero into unlimited. Concurrent zero/omitted requests also shared a cache key; spender and nonce were absent from that key. | Check allowance against the quote's maximum spend; preserve the cap; gate every swap signing flow; use nullish defaulting and bind the in-flight cache to amount, spender and nonce. Regression tests reproduce 10/10/11 and zero versus omitted values and concurrent requests. |
| M1 | Medium | Checking chain only at render time allowed a wallet network switch during asynchronous gas estimation to send approval on another chain. | Check signer chain after estimation and transaction population; submit the populated transaction with explicit chainId. Real installed ethers runtime verification confirmed forwarding of chainId, exact spender and base-unit amount. Tests block changed-chain and wrong-token inputs. |
| L1 | Low | Safe bundled approval/presign bypassed the regular approval gate when a refreshed quote exceeded the cap, risking an unfillable order and wasted gas. | A shared useHandleSwap gate covers regular, Safe approval and Safe ETH bundle flows before widget hooks and signing. Native EOA ETH flow remains exempt. Tests cover rejection and valid exact-cap/existing-allowance cases. |
| L2 | Low | Pending-order approval could display Unlimited but submit a finite amount after removing the downstream unlimited override. | Resolve the final approval mode at OrderPartialApprove; pass the finite amount separately to the toggle. Test confirms finite/unlimited button amounts and display consistency. |
| D1 | High advisory; build tooling | New js-yaml GHSA-2883-xcg3-v3hh caused the existing contracts OSV gate to regress from 60 to 61 HIGH advisories. | Patch existing resolution and lock entry from 4.3.1 to 4.3.2. Frozen install, existing Hardhat tests and OSV pass. Exactly this advisory removed, none added; baseline and exclusions unchanged. |

The initial feature fixes also remove automatic cap expansion after quote refresh, preserve an unchanged editor value on confirmation, revalidate an open editor against new quote requirements, and remove downstream MAX_APPROVE_AMOUNT overrides. The shared approval callback retains exact integer serialization on Ethereum, Optimism, Unichain, Robinhood Chain and Base.

The first chain-binding implementation attempted a Contract.approve chainId override. Final type checking exposed that ethers contracts 5.7.0 rejects this override at runtime. It was replaced with populateTransaction.approve followed by signer.sendTransaction with chainId; no type assertion suppresses the incompatibility.

Maintainer advisory: https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh (patched 4.3.2).

## Reachability, history and false-positive checks

- useApproveCallback has three production callers: TokensTableRow, useZeroApprove and useTradeApproveCallback. Token/amount construction was traced at each; no reachable existing cross-token mismatch was found, and a boundary guard now rejects one.
- useApproveAndSwap has one caller, TradeApproveButton, which is used by the trade button map and OrderPartialApprove. Both finite and unlimited modes were traced.
- useGetPartialAmountToSignApprove has three callers: useGetAmountToSignApprove, TradeChangeApproveAmountModal and TradeApproveWithAffectedOrderList. ChangeApproveAmountModal has two callers, including pending-order approvals.
- Both Safe bundle services have one production caller, useHandleSwap. That shared hook is used by SwapWidget and YieldWidget. All affected signing routes are gated together.
- generatePermitHook has four production callers: useAccountAgnosticPermitHookData, useGeneratePermitHook, handlePermit and PermitHookApp. The nullish default/cache fix is shared; omitted amounts preserve the existing API default.
- Persistent permit state already binds chain, token, account, spender and amount. Approval receipt validation binds token, owner and spender. Account switching does not silently substitute another owner because the signer is account-bound.
- DAI-like permit flow does not expose the finite approval toggle as an EIP-2612 cap; its boolean unlimited behavior is not a new regression.
- History/blame traced the former auto-max and downstream unlimited behavior to the imported approval implementation (a49e05d4) and checked subsequent safety/permit-fallback changes. No recent security fix was removed; Unichain permit fallback remains intact.
- UI changes use React escaping and existing components. No dynamic HTML injection, eval, new signing endpoint, external approval spender, secret or dynamic script loader was introduced. Mobile intent navigation keeps query parameters and uses an internal fixed route.
- The mobile theme is route/viewport scoped and excludes injected widgets. Quote updates do not restart amount animations. Reduced-motion settings cancel running reveals. Dialog stacking and viewport sizing preserve visible controls.

## Validation

- App security/mobile suite: 180 tests across 16 suites pass using the Nx CI command.
- Permit amount/cache suite: 4 tests pass. Initial mobile media-query test: 1 test passes.
- Frontend typecheck and changed-file ESLint pass; seven existing internal-module import warnings remain, no lint errors.
- Semgrep security-audit + secrets: 62 rules over 57 changed production/workflow files, zero findings. The final transaction-population adjustment was subsequently runtime-verified and covered by the approval regressions.
- Playwright Chrome and WebKit: 14 layouts pass (320, 375, 390, 412, phone landscape 844x390, tablet 768 and desktop 1440). Checks cover overflow, phone intent redirect, settings/slippage, token picker, network selector, wallet/account dialogs, color scheme and input zoom. Two additional checks pass for design, reduced motion, viewport changes and route theme restoration.
- Contracts: Node 22/Yarn frozen install; existing Hardhat decoding suite 7 tests; config/YAML compatibility and empty-merge budget regression pass.
- Contracts OSV: critical 10, high 60, moderate 44, low 37. This meets the unchanged existing baseline; it does not mean this legacy development toolchain has zero advisories.
- CI now runs the app security/mobile, permit and media-query regression suites before its existing production build. Existing OTC, fee, token policy and full repository security gates remain enabled.

Reproduce frontend checks from apps/frontend:

```sh
pnpm typecheck
pnpm exec nx run cowswap-frontend:test --testPathPatterns 'src/modules/erc20Approve|src/modules/tradeFlow/hooks/useHandleSwap|src/modules/account/containers/OrderPartialApprove|src/theme/themeConfigAtom|src/ophis/components/intent/IntentEntry' --passWithNoTests=false
pnpm exec nx run permit-utils:test --passWithNoTests=false
pnpm exec nx run common-hooks:test --testPathPatterns useMediaQuery --passWithNoTests=false
node scripts/check-mobile-swap.cjs http://127.0.0.1:3017
```

## Release conditions and limitations

Merge only after the final PR revision passes its security and frontend production-build checks. Deploy through the existing main-triggered Cloudflare workflow, which stages Pages Functions and publishes the greg project. Verify the workflow commit and live swap layouts/API routes after deployment. Release run links and results belong in the PR/release record.

No physical iOS/Android wallet application or real-money transaction was used; browser tests use read-only mock wallets. This review does not certify wallet-specific rendering engines, token contract implementations, deployed settlement contracts or unrelated repository code. Existing repository dependency baselines and dated build-only advisory exceptions are carried unchanged; they are not new clean bills of health. Local Node differs from CI's pinned Node 22, making the remote build mandatory. Remaining rollout scope is mobile swap, not the later whole-site redesign.

## Reviewed file inventory

- `.github/workflows/frontend-ci.yml`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/AddressInputPanel/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/CurrencyAmountPreview/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/CurrencyArrowSeparator/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/CurrencyInputPanel/CurrencyInputPanel.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/CurrencyInputPanel/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/HelpCircle/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/Modal/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/common/pure/Modal/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/legacy/components/Header/AccountElement/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/legacy/components/Header/AccountElement/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/legacy/components/Header/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/account/containers/OrderPartialApprove/OrderPartialApprove.test.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/account/containers/OrderPartialApprove/OrderPartialApprove.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/account/containers/OrdersPanel/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/application/containers/App/RoutesApp.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/application/containers/AppContainer/AppContainer.container.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/application/containers/NetworkSelector/NetworkSelector.container.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/application/containers/NetworkSelector/NetworkSelector.styled.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/containers/ChangeApproveAmountModal/ChangeApproveAmountModal.test.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/containers/ChangeApproveAmountModal/ChangeApproveAmountModal.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/containers/TradeApproveButton/TradeApproveButton.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useApproveAndSwap.test.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useApproveAndSwap.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useApproveCallback.test.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useApproveCallback.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useGetAmountToSignApprove.test.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useGetAmountToSignApprove.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useGetPartialAmountToSignApprove.test.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/hooks/useGetPartialAmountToSignApprove.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/pure/Toggle/Toggle.test.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/pure/Toggle/Toggle.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/erc20Approve/pure/Toggle/styled.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/swap/containers/SwapWidget/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/trade/containers/TradeWidget/TradeWidgetForm.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/trade/containers/TradeWidget/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/trade/containers/TradeWidget/types.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/trade/pure/Settings/styled.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/trade/pure/TradeConfirmation/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/trade/pure/TradeConfirmation/styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/tradeFlow/hooks/useHandleSwap.test.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/tradeFlow/hooks/useHandleSwap.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/tradeFormValidation/pure/TradeFormBlankButton/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/tradeWidgetAddons/containers/SettingsDropdown/SettingsDropdown.container.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/tradeWidgetAddons/containers/SettingsDropdown/SettingsDropdown.styled.tsx`
- `apps/frontend/apps/cowswap-frontend/src/modules/wallet/pure/Web3StatusInner/styled.ts`
- `apps/frontend/apps/cowswap-frontend/src/ophis/components/OphisHeader.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/components/TierChip.module.css`
- `apps/frontend/apps/cowswap-frontend/src/ophis/components/intent/IntentEntry.container.test.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/components/intent/IntentEntry.container.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/components/intent/index.ts`
- `apps/frontend/apps/cowswap-frontend/src/ophis/hooks/useIsMobileSwap.ts`
- `apps/frontend/apps/cowswap-frontend/src/ophis/mobile/MobileSwapGlobalStyle.styled.ts`
- `apps/frontend/apps/cowswap-frontend/src/ophis/mobile/MobileSwapHeader.container.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/mobile/MobileSwapHeading.pure.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/mobile/MobileSwapReveal.pure.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/mobile/MobileSwapTheme.container.tsx`
- `apps/frontend/apps/cowswap-frontend/src/ophis/mobile/mobileSwapTheme.constants.ts`
- `apps/frontend/apps/cowswap-frontend/src/pages/Swap/index.tsx`
- `apps/frontend/apps/cowswap-frontend/src/theme/ThemedGlobalStyle.tsx`
- `apps/frontend/apps/cowswap-frontend/src/theme/themeConfigAtom.test.ts`
- `apps/frontend/apps/cowswap-frontend/src/theme/themeConfigAtom.ts`
- `apps/frontend/apps/cowswap-frontend/src/theme/types.ts`
- `apps/frontend/libs/common-hooks/src/useMediaQuery.test.ts`
- `apps/frontend/libs/common-hooks/src/useMediaQuery.ts`
- `apps/frontend/libs/permit-utils/src/lib/generatePermitHook.test.ts`
- `apps/frontend/libs/permit-utils/src/lib/generatePermitHook.ts`
- `apps/frontend/libs/ui/src/pure/SettingsInput/SettingsInput.pure.tsx`
- `apps/frontend/libs/ui/src/pure/SettingsInput/SettingsInput.styled.ts`
- `apps/frontend/scripts/check-mobile-swap.cjs`
- `contracts/package.json`
- `contracts/yarn.lock`
