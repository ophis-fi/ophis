# Integrated private swap review — 2026-10-28

## Assessment and scope

Independent Codex source review found no remaining concrete fund-loss or security blocker after fixes. Release remains conditional on the final rebuilt/staged artifacts, hosted checks and deployment postflight. This is a review of the client integration, not a formal third-party certification. No new Solidity, dependencies, mainnet contract or public SDK release is introduced. f(x) remains paused.

The engine supports Ethereum, Arbitrum, Polygon PoS and BNB Chain with three pinned assets per chain. It quotes Uniswap v3 only, across four fee tiers and direct or one-intermediate paths: 20 candidates per directed pair. Live factory checks found 48 unique active pools across the four chains at the sampled blocks; pool existence does not establish broadcaster availability. Every supported recipe charges 10 bp once on final output. The public SDK's 1 bp base is unchanged.

The real runtime is embedded inside the existing Ophis swap page. Public-to-private navigation loads a fresh `/private-swap/` document with the separately built `/private/` runtime. Removed sample UI and sample balances are not part of the release. The user's supplied incognito SVG geometry is shared by the main entry and runtime.

## Findings fixed

- Intermediate tokens are swept and included in reshielding. Confirmed private output does not erase recovery when a failed cleanup leaves another configured token publicly held.
- Quote freshness is rechecked after signed simulation, before submission. Recovery is journaled before disclosure to the simulation provider.
- Chain-specific WalletConnect sessions, exact signer-chain checks and journal validation prevent cross-chain state reuse. Existing Ethereum storage keys remain readable; the encrypted master wallet is intentionally shared.
- BNB's legacy gas reporting is mapped to a valid authorization-transaction fee envelope only on BNB. Priority fee never exceeds the cap; the minimum is refreshed before sending.
- Mainnet deposits require a fresh compatible broadcaster before approval and again before shielding. Swap preparation checks receive-token broadcaster availability as well as the sell-token fee. Polygon native USDC and USDC.e had zero compatible advertisements in the final discovery sample; no silent address substitution was made.
- The development proxy disables target-path prepending; a real loopback proxy regression checks path and query forwarding exactly once. Committed frontend state-handler tests cover accepted messages, origin/source rejection, malformed payloads, height bounds and busy navigation gates. Both suites run in hosted CI.
- Private boot skips GA4, Sentry, service-worker registration and destructive public migrations. Public migration preserves encrypted wallet databases, journals and proof artifact caches. CSP blocks remote scripts; COOP separates public opener state. The parent accepts only bounded layout metadata from its own iframe origin and window.
- Nonlocal gateway forwarding requires authentication. The sole API-key exception is the exact server-derived ZAN URL for the selected chain, with a fixed host/path and encoded key. Missing credentials, arbitrary URLs and wrong-chain URLs fail closed. Client authorization is never forwarded.

## Execution evidence

A fresh ethskills QA agent used generated local wallets and guarded loopback Anvil forks. All four networks completed native shielding, actual Railgun proof generation, private swap, confirmed private output and journal cleanup. Exact input/fee debits and recipient transfers reconciled. All 13 recorded financial-source hashes matched the final reviewed source.

| Network   | Wrapped input traded | Receipt gas used |                     Ophis fee units |      Gross output units |
| --------- | -------------------: | ---------------: | ----------------------------------: | ----------------------: |
| Ethereum  |           0.001 WETH |        2,030,053 |               2,323 USDC base units |               2,323,577 |
| Arbitrum  |           0.001 WETH |        2,148,118 |               2,325 USDC base units |               2,325,025 |
| Polygon   |               1 WPOL |        2,008,300 |                  91 USDC base units |                  91,290 |
| BNB Chain |           0.001 WBNB |        1,993,221 | 747,011,634,902,884 USDC base units | 747,011,634,902,884,818 |

Each fee equals `floor(grossOutput * 10 / 10000)`. BNB's pegged stablecoins use 18 decimals; the other listed USDC assets use 6. Receipt success alone was not the assertion: private outputs and cleared journals were observed. No user wallet or real funds were used. Fork POI and a local sponsor are explicit fixtures and do not relax production validation.

The selected Worker gateway passed chain ID, deployed code, canonical delegation, delegated `eth_call` and `debug_traceCall` output checks on all four networks. Ethereum uses Baal; the other networks use the existing Ophis ZAN account. No new provider subscription was created. Public endpoints were rejected after quota/archive/tracing failures, rather than retained as a silent fallback.

## Regression and browser checks

- Engine: 170 tests passed, 8 skipped because live/fork suites require explicit flags; browser and server TypeScript checks passed. Route assertions cover 480 encodings across networks, pairs and paths, including exactly one fee command, the pinned recipient and intermediate-token cleanup.
- Independent final differential checks: 48 targeted tests and 9 middleware tests passed, plus literal ZAN path and encoded-key assertions.
- Frontend TypeScript, targeted ESLint, middleware tests and production builds are checked separately. The production page and iframe rendered with both WASM assets successful, self-only script policy and no page errors or external scripts. The final staged artifacts must be checked again after rebuilding.
- Earlier sample-data layout checks are not treated as financial execution evidence. The funded localhost wallet and its browser profile remained untouched.

Private evidence stays outside the repository. Principal records: `private-four-chain-proof-qa-20261028.json`, `integrated-gateway-readiness.json`, `integrated-broadcaster-readiness.json`, `integrated-browser-modules.json` and final build/test logs. Older evidence contains user financial details and must not be published wholesale.

## Review methods and dependencies

Applied Ponytail minimum-change guidance, ethskills chain/address/frontend/QA rules, Trail of Bits differential-review and token-integration guidance, and independent Codex source/browser review. Pashov's applicable call-level reasoning was considered; its Solidity audit workflow and Verity contract proof workflow are not applicable because no Solidity source changed. This does not claim an audit performed by those organizations.

Jev 1.14 supplied six supplemental source-claim probabilities, from 0.70 to 0.97, covering fee consistency, single output fee, private analytics boot, availability guards and keyed provider construction. Earlier broader prompts had mixed lower confidence. These probabilities are not security proofs; direct source review and executable regressions establish the specific tested behavior.

Version-based production dependency scanning reports 2 critical, 17 high, 11 moderate and 2 low advisories. Existing backports and browser reachability are assessed in `DEPENDENCIES.md`; no dependency upgrade is hidden in this release. The rendered graph excludes tar, form-data and body-parser. Zod 3.25.76 remains reachable, but the affected collection validators were not found in the inspected application path. Patched elliptic, GraphQL utilities, peer-store and legacy WebSocket modules remain in the rendered graph and have focused regression coverage. These are bounded reachability/backport assessments, not an assertion that the dependency graph has zero risk.

## Remaining limits

Live added-chain PPOI delivery and broadcaster acceptance are not established by local proof tests. Broadcaster advertisements and provider quota can change; the runtime checks current offers and retains recovery state. Existing shared ZAN account credit balance was not established. The iframe shares Ophis's first-party origin and is not protection against a compromised same-origin application. DEX calldata and amounts are public, the Ophis fee identifies the route, and a trusted simulation provider sees the signed executable batch. No additional DEX, bridge or arbitrary custom token is enabled.
