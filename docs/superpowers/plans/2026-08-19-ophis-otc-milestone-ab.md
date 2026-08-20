# Ophis OTC — Milestones A+B (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship OTC Milestone A (pinned Ethereum manifest, read-only contract adapter, subgraph index client, direct on-chain reconciliation) and OTC Milestone B (read-only `/otc` UI: browse, filters, order detail, risk labels, wallet views) with binding CI gates and zero reachable transaction selectors.

**Architecture:** A self-contained `src/ophis/otc/` module copying the `src/ophis/discovery/` shape (viem, dependency-injected narrow reader client, fail-closed runtime-code-hash verification, single-block read consistency, structural boundary test), consumed by a flag-gated `/otc` page family built on the Ophis DS Leaderboard pattern. On-chain enumeration (`nextOrderId()` → batched `getOrders`) is the settlement authority; the upstream Goldsky subgraph is enrichment + reconciliation counterpart only. A zero-dependency root canary script (`scripts/otc-mainnet-canary.mjs`, Robinhood-canary pattern) plus a scoped jest step in `frontend-ci.yml` make every exit-gate guard actually run in CI.

**Tech Stack:** viem 2.x (already a cowswap-frontend dep), wagmi `usePublicClient`, SWR, styled-components/macro, jest 30 (nx), Node ESM for the canary.

**Spec:** `docs/development/plans/2026-08-18-ophis-otc.md` (milestone authority, user-quoted A–G ladder) + `docs/development/specs/2026-08-18-ophis-otc-plan.md` (UX/architecture detail). Both currently untracked; Task 1 commits them.

## Global Constraints

- **Read-only, strictly.** No write ABI fragments anywhere; `enabledTransactionSelectors` pinned to `[]`; boundary test asserts the module never encodes any of the 7 known write selectors (`0xfc05ca31 createOrder`, `0xc37dfc5b fillOrder`, `0x514fcac7 cancelOrder`, `0x97bfdd2f createOrderWithEth`, `0x9fe63676 fillOrderWithEth`, `0x21dd76f9 cancelOrderUnwrap`, `0xb50430d8 fillOrderUnwrap`) and imports no wallet-signing/trade/allowance/permit/solver modules.
- **Pinned facts (verified 2026-08-19 via publicnode + drpc + Sourcify exact_match):** chainId 1; contract `0x000000fF3D7A2d373615141d7489Ca66683DbecF`; runtime code keccak256 `0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1`; `weth()` = `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`; deployment block `24622661`; `nextOrderId()` = 144 at block ~25787488. Never follow a remote-config address.
- **Order struct field order is `(maker, active, tokenA, amountA, tokenB, amountB)`** — `active` is SECOND (upstream NatSpec lists it last; the on-chain tuple layout is authoritative, verified by decoding `getOrder(143)`).
- **Fail closed:** code-hash mismatch, `weth()` wiring mismatch, malformed decode, or changed block hash ⇒ zero rows + `unavailable` state; never partial data presented as verified.
- **Token policy:** new `OTC_ESCROW` profile in `libs/tokens/src/services/tokenPolicy.ts` = exactly {WETH, USDC, DAI} on mainnet (NO native sentinel); existing profiles and all 13 existing call sites untouched.
- **Display metadata for tokens comes only from Ophis-curated constants; subgraph/on-chain names are never rendered.** Unreviewed tokens display as shortened address + "Unreviewed" risk label.
- **Feature flag `isOtcEnabled`:** absent from `useFeatureFlags` defaults (⇒ `undefined` ⇒ off in prod); route mounts when `isOtcEnabled === true || isLocal`. No nav/footer entry (public navigation is Milestone G).
- **House style:** named exports only, `*.container/pure/styled` naming, explicit return types, no `any`, complexity ≤10, ≤80 lines/function, `styled-components/macro`, `common/hooks/useNavigate` (never react-router's), `ms.macro` intervals, `// Ophis:` provenance comments on routes, plain-English strings on Ophis DS pages (no lingui churn).
- **Conventional commits `feat(otc): …` / `docs(otc): …` / `test(otc): …` / `ci(otc): …`,** subject ≤72 chars, no emoji. Branch `feat/otc-read-only`. Squash-merge repo.
- **Record every new Ophis file in `apps/frontend/.ophis-divergences.md`.**
- **No new npm dependencies** (no lockfile churn): subgraph client is a hand-rolled `fetch` POST with strict manual validation.
- **NO DEPLOY. Draft PR only; merge/enable requires Clement's explicit approval.** Milestones C+ are out of scope.

## File Structure

```
docs/development/plans/2026-08-18-ophis-otc.md            (commit user's plan, as-is)
docs/development/specs/2026-08-18-ophis-otc-plan.md       (commit user's spec, as-is)
docs/superpowers/plans/2026-08-19-ophis-otc-milestone-ab.md (this plan)

apps/frontend/libs/tokens/src/services/tokenPolicy.ts     (+OTC_ESCROW member + branch)
apps/frontend/libs/tokens/src/services/tokenPolicy.spec.ts (+OTC_ESCROW cases)

apps/frontend/apps/cowswap-frontend/src/ophis/otc/
  otc.const.ts            manifest (pins, deployment block, batch/size/time bounds,
                          enabledTransactionSelectors: [], KNOWN_WRITE_SELECTORS,
                          subgraph URL, policy profile id)
  otc.abi.ts              read-only ABI fragments + events (no write fragments)
  otc.types.ts            OtcOrder, OtcReaderClient, OtcSnapshot, OtcIndexedOrder,
                          OtcReconciliationReport, OtcDataState
  parseOtcOrders.ts       strict validation of decoded getOrders tuples → OtcOrder[]
  readOtcSnapshot.ts      pinned-code + weth wiring + nextOrderId + batched getOrders
                          + block-hash consistency → OtcSnapshot
  otcSubgraph.ts          fetch-based Goldsky client (+_meta lag), strict validation
  reconcileOtcOrders.ts   pure exact-equality reconciliation index↔chain
  otcTokenMeta.ts         curated token metadata + escrow-risk labels (OTC-scoped)
  otcAmounts.ts           bigint→exact display, rate computation (pure)
  useOtcData.ts           SWR hook: snapshot (authority) + subgraph enrichment + lag
  otc.boundary.test.ts    structural import + selector-reachability test
  parseOtcOrders.test.ts / readOtcSnapshot.test.ts / otcSubgraph.test.ts /
  reconcileOtcOrders.test.ts / otcAmounts.test.ts / otcTokenMeta.test.ts
  __fixtures__/getOrders-batch.json, getOrder-143.json, subgraph-orders.json
  index.ts                barrel

apps/frontend/apps/cowswap-frontend/src/pages/Otc/
  Otc.page.tsx            container: tabs Browse / My orders / Create(disabled stub),
                          disclosure header, state machine rendering
  OtcOrdersTable.tsx      pure DS-table with filters (pair/maker/orderId)
  OtcOrderDetail.page.tsx /otc/:orderId — direct getOrder read, full terms,
                          technical section (contract addr + explorer)
  OtcDisclosure.tsx       6-point plain-language disclosure, Accordion detail
  Otc.styled.ts           styled bits
  index.ts                barrel (named exports)

apps/frontend/apps/cowswap-frontend/src/common/constants/routes.ts   (+OTC, OTC_ORDER)
apps/frontend/apps/cowswap-frontend/src/modules/application/containers/App/RoutesApp.tsx (+2 lazy routes)
apps/frontend/.ophis-divergences.md                       (+entries)

scripts/otc-mainnet-canary.mjs                            zero-dep static+live canary
.github/workflows/otc-mainnet-canary.yml                  static on PR paths, live cron
.github/workflows/frontend-ci.yml                         (+scoped jest step)
```

---

### Task 1: Commit the planning documents

**Files:** the three docs above (user's plan + spec already copied into the worktree; this implementation plan).

- [ ] `git add docs/development/plans/2026-08-18-ophis-otc.md docs/development/specs/2026-08-18-ophis-otc-plan.md docs/superpowers/plans/2026-08-19-ophis-otc-milestone-ab.md`
- [ ] Commit: `docs(otc): add OTC integration plan, UX spec, and milestone A+B implementation plan`

### Task 2: OTC_ESCROW token-policy profile (TDD)

**Files:** Modify `apps/frontend/libs/tokens/src/services/tokenPolicy.ts`, `…/tokenPolicy.spec.ts`.

**Interfaces — Produces:** `TokenPolicyProfile.OTC_ESCROW = 'otc-escrow'`; `getTokenPolicyDecision({chainId, address}, TokenPolicyProfile.OTC_ESCROW)` allows exactly WETH/USDC/DAI mainnet addresses; everything else `token-not-reviewed`; non-mainnet `chain-not-reviewed`; native sentinel `token-not-reviewed` (raw calls; `getCurrencyTokenPolicyDecision` still normalizes native→wrapped which resolves to WETH = allowed, matching the spec's "ETH only via reviewed WETH convenience functions" display posture).

- [ ] Write failing spec cases: WETH/USDC/DAI mainnet → approved; native sentinel mainnet → token-not-reviewed; USDC on chain 10 → chain-not-reviewed; random address mainnet → token-not-reviewed; existing profiles' cases still pass unchanged.
- [ ] Run `npx nx run tokens:test -- --testPathPatterns tokenPolicy` — expect new cases FAIL.
- [ ] Implement: add enum member; add `OTC_ESCROW_ETHEREUM_ASSETS = new Set([WETH_MAINNET.address, USDC_MAINNET.address, DAI.address].map(getAddressKey))`; branch after the existing mainnet gate mirroring RESTRICTED_EXECUTION but against the OTC set.
- [ ] Run scoped test — PASS. Commit: `feat(otc): add OTC_ESCROW token-policy profile (WETH/USDC/DAI, mainnet-only)`

### Task 3: Manifest, ABI, types + boundary test (TDD)

**Files:** Create `otc.const.ts`, `otc.abi.ts`, `otc.types.ts`, `otc.boundary.test.ts`, `index.ts`.

**Interfaces — Produces:**
- `OPHIS_ETHEREUM_OTC_MANIFEST: OtcManifest` = `{ chainId: 1, chainLabel: 'Ethereum', contract: {address: '0x000000fF3D7A2d373615141d7489Ca66683DbecF', runtimeCodeHash: '0x8d9a…eda1'}, wethAddress, deploymentBlock: 24622661n, orderBatchSize: 64, maxEnumeratedOrders: 1000, maxReturnBytes: 32_768, callGasLimit: 2_000_000n, readTimeoutMs: 8_000, subgraphUrl, subgraphTimeoutMs: 8_000, maxIndexLagBlocks: 60n, tokenPolicyProfile: 'otc-escrow', enabledTransactionSelectors: [] }`
- `OTC_READ_ABI` (getOrder, getOrders, canFill, weth, nextOrderId — all `view`) + `OTC_EVENT_ABI` (OrderCreated/OrderFilled/OrderCanceled). Order tuple components in on-chain order: maker, active, tokenA, amountA, tokenB, amountB.
- `OTC_KNOWN_WRITE_SELECTORS` (the 7 selectors, as documentation + negative-test data).
- Types per File Structure.

- [ ] Write `otc.boundary.test.ts`: (a) discovery-style forbidden-import scan over `__dirname` with fragments `['modules/trade', 'modules/swap', 'modules/tokensList', 'tradeFlow', 'allowance', 'permit', 'solver', 'signing', 'useWalletProvider']`; (b) `OTC_READ_ABI.every(f => f.stateMutability === 'view')`; (c) computed `toFunctionSelector` of every ABI fragment ∉ `OTC_KNOWN_WRITE_SELECTORS`; (d) `enabledTransactionSelectors` strictly `[]`; (e) manifest literals match the pinned constants above.
- [ ] Run scoped jest — FAIL (files missing) → implement const/abi/types/barrel → PASS.
- [ ] Commit: `feat(otc): pinned Ethereum manifest, read-only ABI, boundary test`

### Task 4: Record fixtures from mainnet

**Files:** Create `__fixtures__/getOrders-batch.json` (raw hex eth_call result for a real id batch incl. 143 + a filled + a cancelled + a non-existent id), `__fixtures__/getOrder-143.json`, `__fixtures__/subgraph-orders.json` (real Goldsky response incl. `_meta.block`). Each carries `{recordedAt, blockNumber, request, response}`.

- [ ] Fetch via cast/curl against drpc + subgraph; verify getOrder(143) decodes to the subgraph's order 143 values before saving (this re-proves the tuple order).
- [ ] Commit: `test(otc): record mainnet fixtures (orders batch, order 143, subgraph page)`

### Task 5: parseOtcOrders + otcAmounts (pure, TDD)

**Interfaces — Produces:** `parseOtcOrders(decoded: unknown, requestedIds: bigint[]): OtcOrder[]` — strict shape validation (address checksum via `getAddress`, bool active, uint256 bounds), drops default-struct rows (maker == zero ⇒ order does not exist), pairs by index with requestedIds. `computeOtcRate(order, metaA, metaB): {rate: string, inverseRate: string} | null` and `formatOtcAmount(amount: bigint, decimals: number): string` — exact, no float rounding of on-chain values (bigint + manual decimal-point insertion; trim trailing zeros, keep full precision).

- [ ] Failing tests from fixtures (real decoded tuples incl. order 143 = 100e18 ZAMM → 1e18 WETH) + malformed rows (wrong arity, non-address, negative) + zero-maker dropping + amount formatting edges (0, 1 wei, 6-dec USDC, trailing zeros).
- [ ] Implement → PASS. Commit: `feat(otc): strict order decoding and exact amount math`

### Task 6: readOtcSnapshot (TDD, mocked client)

**Interfaces — Consumes:** Task 3 manifest/ABI, Task 5 parser. **Produces:** `readOtcSnapshot(client: OtcReaderClient, manifest?): Promise<OtcSnapshot>` where `OtcSnapshot = {blockNumber, blockHash, nextOrderId, orders: OtcOrder[], truncated: boolean}` and `OtcReaderClient = {getLatestBlock, getBlockByNumber, getCode, call}` (identical to the discovery reader shape).

Algorithm (single-block consistency, discovery pattern): latest block (hash required) → `requirePinnedCode(contract)` → `weth()` bounded call must equal manifest.wethAddress → `nextOrderId()` → enumerate ids `max(1, next−maxEnumeratedOrders) … next−1` newest-first in `orderBatchSize` chunks via `getOrders(uint256[])` bounded calls, all at the pinned blockNumber → parse → re-read block by number, hash must be unchanged → snapshot with `truncated = next−1 > maxEnumeratedOrders`.

- [ ] Failing tests: happy path (fixture-backed mock returns); code-hash mismatch throws `'Ophis OTC source mismatch'`; weth mismatch throws wiring error; block-hash change throws; returndata over `maxReturnBytes` rejected; truncation flag; batching math (ids split correctly, newest first).
- [ ] Implement → PASS. Commit: `feat(otc): read-only snapshot reader with fail-closed pinning`

### Task 7: otcSubgraph client (TDD, mocked fetch)

**Interfaces — Produces:** `fetchOtcIndexedOrders(signal?): Promise<{orders: OtcIndexedOrder[], indexedBlock: bigint}>`; `OtcIndexedOrder = {orderId, maker, active, tokenA, amountA, tokenB, amountB, createdAt, createdTx, filledAt?, filledTx?, taker?, cancelledAt?, cancelledTx?}` — all address/hex/uint fields strictly validated, anything malformed drops the ROW (and a fully malformed body throws). `computeIndexLag(indexedBlock, chainBlock): bigint`.

- [ ] Failing tests from `subgraph-orders.json` fixture + malformed variants (bad address, non-numeric BigInt string, missing _meta ⇒ throw) + lag math.
- [ ] Implement (POST `{query}` with AbortSignal.timeout(manifest.subgraphTimeoutMs), first page `orders(first: 1000, orderBy: orderId, orderDirection: desc)` + `_meta{block{number}}`) → PASS.
- [ ] Commit: `feat(otc): subgraph index client (discovery-only) with strict validation`

### Task 8: reconcileOtcOrders (pure, TDD)

**Interfaces — Produces:** `reconcileOtcOrders(indexed: OtcIndexedOrder[], snapshot: OtcSnapshot): OtcReconciliationReport` = `{verifiedIds, mismatches: [{orderId, field, indexed, onchain}], missingOnchain, notIndexed, activeAgreementCount}` — exact equality (checksummed address compare, bigint compare) on maker/active/tokenA/amountA/tokenB/amountB for every order id both sides claim; ids the index calls active but the chain doesn't (or vice versa) are mismatches on `active`; ids outside the snapshot's enumerated range are `unknown` and excluded from verified.

- [ ] Failing tests: full agreement; single-field mutation of each of the 6 fields detected (mutation-style: assert every field binds); active/inactive disagreement; index-only id; chain-only id; truncated-range exclusion.
- [ ] Implement → PASS. Commit: `feat(otc): direct on-chain reconciliation with per-field mismatch reporting`

### Task 9: otcTokenMeta + useOtcData hook

**Interfaces — Produces:** `getOtcTokenMeta(address): OtcTokenMeta | null` where meta = `{symbol, name, decimals, escrowRisks: readonly string[]}` — curated constants only (WETH: [], USDC: ['upgradeable', 'blacklistable'], DAI: []); null for everything else. `isOtcOrderActionable(order): boolean` = both legs pass `getTokenPolicyDecision(…, OTC_ESCROW)`. `useOtcData(enabled: boolean): OtcDataState` — SWR (`ms\`30s\``, focus-paused, no revalidateOnFocus), wagmi `usePublicClient({chainId: MAINNET})` wrapped into `OtcReaderClient` exactly like `useOphisDiscovery`, combines snapshot (authority) + subgraph enrichment (timestamps/history) + `reconcileOtcOrders` + lag: `{status: 'loading'|'ready'|'degraded'|'unavailable', snapshot, enrichment, reconciliation, indexLagBlocks, error}` — `degraded` = chain OK but subgraph failed/stale (UI shows rows without ages + banner), `unavailable` = chain read failed (no rows, fail closed).
- [ ] Tests for meta/actionability (jest). Hook covered via page render tests in Task 11 (house precedent: `useOphisDiscovery` untested directly).
- [ ] Commit: `feat(otc): curated escrow token metadata and combined data hook`

### Task 10: Routes + flag gating

**Files:** Modify `routes.ts` (`OTC: '/otc'`, `OTC_ORDER: '/otc/:orderId'` with `// Ophis:` comments), `RoutesApp.tsx` (two lazy routes, webpackChunkName `ophis_otc`, mounted only when `isOtcEnabled === true || isLocal` — else element is `<Navigate to={RoutesEnum.HOME} replace />`).

- [ ] Implement; verify `pnpm typecheck` passes; verify flag-off renders NotFound-equivalent (covered by Task 11 render test).
- [ ] Commit: `feat(otc): flag-gated /otc routes (off by default in production)`

### Task 11: Read-only /otc pages (Milestone B)

**Files:** Create `src/pages/Otc/*` per File Structure.

Page requirements (from spec §Navigation/Browse/Detail/Accessibility):
- Header: "OTC" title, Ethereum badge, disclosure block (Task 12 component) — primary warning visible without interaction.
- Tabs: Browse | My orders | Create. Create tab = disabled button with `aria-disabled` + explanatory copy ("Order creation is not yet enabled…"). My orders = same table filtered `maker === connected account` (via `useWalletInfo().account`), empty-state prompting connection when absent; includes resolved orders from enrichment when available.
- Browse table (DS `Table` with `caption`): columns Order # / Sells / Wants / Rate / Maker / Age / Status. Amounts exact via `formatOtcAmount`; tokens via curated meta or `0x1234…abcd` + "Unreviewed" badge; Rate only when both metas exist; Maker shortened + copy button (aria-label) + etherscan link; Age from enrichment else "—"; Status badges with text (Active / Verified on-chain / Data mismatch / Unreviewed token) — never color-only. Filters: token (curated select), maker address, order id — client-side, plain inputs with labels.
- Detail route `/otc/:orderId`: on open performs a DIRECT `getOrder` read (fresh, own SWR key, no cache reuse) plus pinned-code check; shows full checksummed addresses both legs, exact amounts, active state, escrow explanation, "Verified on-chain at block N" line, technical section (contract address + explorer link, order id), risk labels; if the indexed row disagrees with the direct read ⇒ prominent "Order data changed — refresh required" and no actionable affordance (there are none anyway in B).
- States: loading skeleton (no animation dependence), `unavailable` (Callout tone warning, "on-chain verification failed — nothing is shown", fail closed), `degraded` (rows shown, banner "Index data unavailable/stale — ages and history hidden; on-chain state shown"), empty ("No active orders"), stale-lag banner when `indexLagBlocks > maxIndexLagBlocks`.
- Accessibility: table caption, `th scope`, focus-visible outlines, aria-labels on icons/copy buttons, no motion-dependent affordances, keyboard reachable tabs (real buttons), mobile: cards stack via `ScrollWrapper` + responsive styles (no horizontal body scroll).

- [ ] Render tests (`Otc.page.test.tsx`, mock `useOtcData` + `useWalletInfo`): loading; unavailable hides all rows; ready renders fixture rows with exact amounts; unreviewed-token row shows address + badge and no rate; my-orders filters by account; create tab disabled; degraded shows banner; **structural: rendered page contains zero elements with onClick handlers that reach any wallet/signing API (assert no `sendTransaction|signTypedData|approve` strings in module graph — covered by boundary test — plus DOM has no enabled button labeled fill/create/cancel)**.
- [ ] Implement pages → tests PASS → `npx nx run cowswap-frontend:typecheck` PASS.
- [ ] Commit: `feat(otc): read-only /otc browse, my-orders, and order-detail views`

### Task 12: Disclosure component

**Files:** Create `OtcDisclosure.tsx` (part of pages dir). Six plain-language points verbatim from the spec: external immutable escrow contract; creating/cancelling costs gas; orders do not expire on-chain; fills are all-or-nothing; public transactions may be raced; only Ophis-reviewed assets are supported in this interface. Primary line always visible; details in DS `Accordion` (native details/summary). Folded into Task 11's tests (assert all six phrases render).

### Task 13: Canary script + workflows (guards that bind)

**Files:** Create `scripts/otc-mainnet-canary.mjs`, `.github/workflows/otc-mainnet-canary.yml`; modify `.github/workflows/frontend-ci.yml`.

- Canary (zero-dep Node ESM, `robinhood-mainnet-canary.mjs` pattern): embedded manifest copy; `--self-test` mode = decode/reconcile self-checks against embedded fixture hex + **manifest-drift gate**: parse `src/ophis/otc/otc.const.ts` textually and require address/code-hash/weth/deployment-block equality with the embedded copy (numeric normalization; a crafted-drift self-check proves the extractor can fail). Live mode = RPC (`OTC_CANARY_RPC_URL` env, default publicnode for calls; document that getLogs is NOT used): eth_getCode → keccak (pure-JS keccak over hex — implement minimal keccak-f[1600] or reuse an existing in-repo zero-dep helper if one exists; verify against the pinned hash), `weth()`, `nextOrderId()`, decode a 3-id `getOrders` batch, fetch one subgraph page and reconcile — any mismatch exits 1.
- Workflow: `static` job on `pull_request` paths (`scripts/otc-mainnet-canary.mjs`, `apps/frontend/apps/cowswap-frontend/src/ophis/otc/**`, the workflow file) runs `--self-test`; `live` job on `schedule` (daily, offset from robinhood cron) + `workflow_dispatch`.
- frontend-ci.yml: add step after typecheck — `pnpm exec nx run cowswap-frontend:test --testPathPatterns 'src/(ophis/otc|pages/Otc)'` and `pnpm exec nx run tokens:test --testPathPatterns tokenPolicy` (verify exact jest-30/nx passthrough syntax locally first).
- [ ] Run `node scripts/otc-mainnet-canary.mjs --self-test` (PASS) and `--self-test --mutate` style negative check; run live once locally (PASS, no secrets).
- [ ] Commit: `ci(otc): mainnet canary (static+live) and scoped frontend test gate`

### Task 14: Divergences registry + gates + PR

- [ ] Append all new/modified frontend files to `apps/frontend/.ophis-divergences.md` under "Added (Ophis-only)".
- [ ] Full gates from `apps/frontend/`: `pnpm typecheck`, scoped jest suites, `pnpm exec nx run cowswap-frontend:lint` (scoped if slow), `pnpm build:cowswap` (production build must succeed — this is what frontend CI runs).
- [ ] Visual verification (feedback_verify_ui_visually_before_shipping): `pnpm start` (or vite dev), navigate `/#/otc` locally (isLocal ⇒ mounted), screenshot browse/detail/empty/unavailable states via Playwright/Chrome MCP; check mobile viewport.
- [ ] Adversarial review workflow on the full diff (correctness / security / spec-compliance / a11y lenses, verify each finding), fix confirmed findings; write `OPHIS_OTC_DIFFERENTIAL_REVIEW_2026-08-19.md` (house template: Date/Baseline/Review target/Deployment: Not authorized).
- [ ] Push branch, open **draft** PR `feat(otc): OTC milestones A+B — pinned manifest, read-only adapter, /otc read-only UI` with template sections + Safety boundaries (PR #1200 style). Do NOT merge.

## Self-Review

- Spec coverage: Milestone A deliverables → Tasks 3–8, 13 (fixtures match contract state = Task 4 + canary live; code-hash fails closed = Tasks 6, 13). Milestone B → Tasks 9–12 (no tx selectors reachable = Tasks 3, 11 boundary+render tests; a11y/responsive = Task 11). Required implementation controls: pinning (T3), subgraph-as-index-only (T7/T9), escrow policy (T2), curated metadata only (T9), no gas-free claims (T12 copy), analytics — N/A read-only (no analytics added). RPC decision: wallet-free provider reads (T9 hook), no archive dependency (enumeration bootstrap, T6).
- Deviations (documented): price-deviation-vs-reference deferred (rate + inverse shown; no external price feed in v1 read-only — avoids a new data dependency; spec marks deviation "optional"). Event ingestion (checkpointed eth_getLogs) deferred to the Ophis-owned mirror work pre-GA; A/B use enumeration + subgraph which the spec's bootstrap section explicitly supports. My-orders "resolved" history shown only when subgraph available (v1 honesty note in UI).
- Types consistent across tasks (OtcOrder/OtcSnapshot/OtcIndexedOrder/OtcReaderClient defined once in T3, consumed by name later).
