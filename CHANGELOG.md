# Changelog

All notable changes to Ophis are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project loosely follows [Semantic Versioning](https://semver.org) with
named phase tags for major milestones.

## [Unreleased]

### Fixed
- Reward-claim review follow-ups on the merged #1096, two of them user-facing defects that were live in production. (1) The claim email is now BOUND INTO THE SIGNED MESSAGE (`Ophis claim reward <id> for <email>`) instead of riding along as unsigned JSON. The email is the address the partner mails the code to, so leaving it unsigned meant a signature captured inside the 5-minute replay window could be replayed with an attacker's address swapped in: the victim's wallet proves eligibility, the attacker receives the code. A signature now authorizes exactly one (reward, email) pair, and the pre-binding message shape no longer verifies at all. This inverts the frontend flow for partner-fulfilled perks, which now collect the email BEFORE signing rather than signing on "Claim reward" and asking afterwards. (2) The email pattern rejected every multi-label domain: not only `mail.example.co.uk` but the whole `.co.uk` / `.com.au` / `.co.jp` family, because the domain character class excluded dots. Real users with those addresses got a 400 from an endpoint the browser's `type="email"` control had already accepted. The class now allows dots; both halves still exclude `@`, so matching stays linear on the 254-capped input. (3) The expired-signature dead end is gone as a consequence of (1): the signature is produced at submit time and spent milliseconds later, so it cannot go stale in an open form, and every failure path now leaves the form intact and retryable instead of stranding the user with no way back to "Claim reward" short of a refresh. Covered by 11 new tests, including a regression that fails if the email binding is ever removed.

### Added
- Reward claims are now collected instead of ending at a `mailto:` link. Partner-fulfilled perks (Octav) are issued by the partner, which means Ophis has to hand the partner a list of who claimed, and there was none: the `/rewards` claim flow finished by opening the visitor's mail client with a pre-filled message, so a claim only existed if that mail was actually sent, and nothing was ever recorded. The validated panel now renders an email + consent form (`RewardClaimForm`) that posts to a new `POST /rewards/claim` on the rebate indexer, which re-verifies everything server-side before storing: the EIP-191 signature proves control of the wallet (namespaced `claim reward <id>`, so a partner-dashboard signature cannot be replayed into a claim), the XP threshold comes from a server-side catalog (`apps/rebate-indexer/src/rewards.ts`, the authority for what is claimable), and the XP balance is recomputed from indexed trades rather than taken from the client. Claims are stored one row per (wallet, reward) in the new `reward_claims` table (migration 0025), so re-claiming corrects the email instead of duplicating a row the partner would mail twice. Self-service perks that ship a public code in the bundle (Keystone) are rejected by the endpoint, since that would be collecting PII with no hand-off to serve. The pre-filled mail survives as the fallback when the POST fails, so an indexer outage never strands an eligible reward. Operators export the list with the admin-only `GET /rewards/claims?reward=octav-20&format=csv` (`since=` for incremental hand-offs; CSV cells are quoted and formula-defanged, since a claimer-chosen email opens in the partner's spreadsheet). The claim form states the purpose plainly: the email is used only to contact the claimer about the reward they claimed (the partner needs it to send the code), never for marketing or any other commercial purpose, a promise the RUNBOOK binds the exports to. Hand-off procedure + deletion handling: `apps/rebate-indexer/RUNBOOK.md` § "Handing reward claims to a partner".

### Fixed
- Compat Wave 3 external-review round 2 (six edge cases on the merged #928): (1) `@ophis/compat-api` mapping rejected mapped `referralFee` values below the backend per-pair partner-fee floor (`enforce_partner_fee_floor`): a non-stable, non-boosted pair floors at 4 bps per entry and the Ophis default entry does not rescue the separate integrator entry, so the minimum mappable is now the conservative 4 bps (the reduced 1-bps floor applies only to stable/boosted pairs, which the Worker cannot establish without an on-chain token registry). (2) the settlement long-poll treated any trade as terminal, but a `partiallyFillable` order stays open after a partial fill; it now uses the authoritative `fulfilled` status and only accepts a trade as terminal for a fill-or-kill order (covering the indexer-lag window before the status flips). (3) pathViz degradation is now checked per artifact: when the graph renders but the image degrades to null (or vice versa), the `PATH_VIZ_UNAVAILABLE` warning fires for exactly the missing artifact instead of only when both are null. (4) `/sor/assemble` re-checks the `COMPAT_PARTNER_FEE_ENABLED` master switch and refuses a still-valid `pathId` that carries a mapped partner fee when the flag was turned off after the quote, so the flag protection holds end to end. (5) `@ophis/sdk` `buildOphisFullAppData` / `buildOrder` enforce the backend 3-entry `partnerFee` cap (`MAX_PARTNER_FEE_ENTRIES`), accounting for the default fee slot the Ophis fee chains consume, so an over-cap document throws at build time instead of failing at ingress. (6) the frontend MEV-receipt decoder (`buildReceipt.ts`) now handles a `metadata.partnerFee` ARRAY (a compat order that mapped a referral fee) by selecting the Ophis-recipient entry, so those settled orders report the Ophis fee instead of showing none; a single-object partnerFee is unchanged.
- `@ophis/sdk` mixed-chunk preflight guards + predicate docs correction (review findings on the still-unpublished 0.3.0): `batchSize: 0` cannot be enforced on every client (in viem 2.48.8 an explicit client-level `batch.multicall.batchSize` overrides the per-call value, and an arbitrary structural `OphisMulticallClient` may chunk however it likes), so a chunk dying on transport while another succeeded produced mixed failure entries that slipped past the all-failure gate and zeroed the dead chunk's tokens. Two guards close this: pair consistency (each check's `balanceOf`/`allowance` pair must fail or succeed together; a genuine token revert fails both, so a half-failed pair throws `OphisPreflightError` naming the token and both entry states) and a widening-only transport-shape check (a failure entry whose error cause chain carries `HttpRequestError` / `RpcRequestError` / `TimeoutError` / `WebSocketRequestError` throws instead of zeroing, even when its pair partner failed too; the name list is diagnostic-informed, the pair and all-failure rules stay the load-bearing gates). Docs now state the single-snapshot guarantee precisely (holds for clients honoring `batchSize: 0`; viem defaults do) and the `withOphisRetry` docs no longer claim a custom `shouldRetry` "can only narrow": only the two terminal classes are protected ahead of the predicate; for everything else a custom predicate replaces the default entirely and can broaden it deliberately.
- `@ophis/sdk` preflight/retry hardening (review findings on the unpublished 0.3.0, so no version bump): (1) an ALL-failure multicall batch now throws `OphisPreflightError` carrying the underlying errors as an `AggregateError` cause, closing a fail-open where viem's `allowFailure: true` swallows a rejected aggregate `eth_call` (RPC outage) into per-contract failure entries and the preflight would have answered with zero balances ("insufficient funds" UX during an outage); per-token zeroing now applies only to PARTIAL failures, and a single check whose both reads fail throws instead of reporting not-ready (deliberate behavior change). (2) `ophisPreflight` passes `batchSize: 0` so viem cannot silently chunk the batch (default 1024-byte chunks): the whole preflight is one `eth_call` and every read comes from the same block snapshot. (3) `withOphisRetry` rethrows the terminal classes (`OphisRateLimitError`, `OphisUnroutableError`) BEFORE consulting a caller-supplied `shouldRetry`, so no custom predicate can resurrect 429 or an unroutable answer (for all other errors a custom predicate replaces the default policy entirely).

### Added
- `@ophis/compat-api` Wave 3 follow-ups + Mode B1 measurement (sync-quote-compat). Three reserved fields of the Mode A surface now work, plus settlement-latency instrumentation. (1) `referralFee` mapping: with partner-fees Phase A merged (#926), a non-zero Odos `referralFee` maps to a CIP-75 Volume `metadata.partnerFee` entry to `referralFeeRecipient` embedded beside the Ophis default fee (the doc's `partnerFee` becomes an array, the shape the app-data `Validator` accepts). The Odos decimal fraction converts to bps (0.001 = 10 bps, rounded to the nearest bps; a fee too small for 1 bps is rejected). The program-wide 90 bps third-party cap (`MAX_THIRD_PARTY_VOLUME_BPS`) is enforced by REJECTING (`PARTNER_FEE_CAP_EXCEEDED`) rather than silently clamping down, so a partner never charges less than asked; a recipient's own registered cap (default 50 bps) is enforced by the orderbook at submit. Gated behind `COMPAT_PARTNER_FEE_ENABLED` (default off), flipped in lockstep with the backend `partner-fee-registry.registration-enabled` master switch; while off, a non-zero fee still hard-rejects with `PARTNER_FEE_UNAVAILABLE` rather than minting a draft that fails at ingress. The mapped fee round-trips through the stateless `pathId` so `/sor/assemble` rebuilds the identical appData. (2) `pathViz` wiring: when the caller sets the Odos `pathViz`/`pathVizImage`/`pathVizImageConfig` flags, the compat quote requests the pathviz route graph from `POST /api/v1/quote` (#924, quote-time wire-name parity) and returns it in the reserved `pathViz`/`pathVizImage` response fields; pathviz ships flag-disabled, so it warns-and-degrades to null (never a hard dependency). (3) Mode B1 measurement: every quote carries `ophis.expectedSettlementSeconds`, a typical quote-to-settlement latency derived from the Optimism autopilot run-loop (20s solve-deadline + ~2 blocks confirmation ~= 24s), configurable via `COMPAT_SETTLEMENT_BASELINE_SECONDS` and stated as an estimate not a guarantee; a new bounded settlement long-poll `GET /sor/settlement/{chainId}/{orderUid}?waitSeconds=` proxies the order + trades status already polled, resolving when the order settles or the clamped wait elapses (no unbounded retries in a Worker). The migration guide publishes the latency framing, the settlement long-poll, and the partner-fee mapping.
- Partner-fees Phase A (backend registry + registry-aware validation, flag off): a Postgres `partner_fee_recipients` registry (`V110`) is the ingress source of truth for THIRD-PARTY partner-fee recipients, replacing the compile-time allowlist for self-serve integrators while the Ophis partner-fee Safe stays always-allowed. Self-serve registration (`POST /api/v1/partners`, EIP-191 signature proving recipient control, 300s replay window, immutable) auto-activates at a 50 bps default cap under a 90 bps program cap (owner decisions 16/19; the auto-activation reopens audit finding C3/F6 in a bounded 0.9% form, bounded by the per-partner cap, the 100 bps autopilot clamp, the suspend switch, and the autopilot defense-in-depth filter). The app-data `Validator` gained a registry-aware `RecipientPolicy` (`Validator::new(size_limit, recipient_policy)` + `Validator::permissive` for read paths), enforcing an entry cap, Volume-policy-only, and the per-partner cap against the AGGREGATE Volume bps per recipient (so duplicate entries cannot stack past the cap); the autopilot `ProtocolFees` consults the same 30s `ArcSwap` snapshot and clamps each recipient's fees to its remaining per-partner budget, so the cap binds on every path including eth-flow / on-chain orders (drop metric `recipient_not_registered`). `GET /api/v1/partners/{address}` and the WAF-gated `GET /restricted/api/v1/partner_fees` accrual feed (which reports the actually-applied `order_execution` protocol fees, paged by a `(block, log_index)` cursor) land the accrual-ready data shapes for the Phase B payout pipeline (the 80/20 split constant is defined once in `app-data`; monthly WETH payouts and sanctions screening are Phase B). `partner-fee-registry.registration-enabled` is the master switch: `false` (the default) loads no registry and consults no registry row on any path, so behavior is byte-for-byte pre-registry (only the Ophis Safe passes); per-row `status` suspend is the granular control once enabled.
- `@ophis/compat-api` (sync-quote-compat Mode A, Wave 2 of the Odos extraction program): a Cloudflare Worker at `apps/compat-api/` serving an Odos-compatible synchronous quote surface at compat.ophis.fi. `POST /sor/quote/v3` accepts the v3 request shape (PathRequestV3 field names, single token in/out; multi-token arrays return `MULTI_TOKEN_UNSUPPORTED` naming the basket roadmap) and answers with the QuoteResponse field surface plus a namespaced `ophis` block: unsigned CoW order draft (built via the `@ophis/sdk` order-build core from WP0, receiver pinned to the owner), EIP-712 signing envelope, exact `fullAppData`, and explicit async-settlement semantics (`settlementModel: 'batch-auction-async'`). `POST /sor/assemble` verifies a stateless HMAC `pathId` (60s cap, two-key rotation) and rebuilds the draft with `transaction: null` always; `POST /sor/swap/v3` combines both; `POST /sor/submit` is a keyless relay that re-runs the full validation set (appData re-hash, receiver guard with explicit `acceptNonOwnerReceiver` ack, uint bounds) before forwarding the OrderCreation with `quoteId`; `GET /sor/order-status/{chainId}/{orderUid}` proxies order + trades with a 3s cache. Values are native-denominated (`ophis.valueCurrency: 'native'`, `percentDiff` 0, `priceImpact` null) until a USD feed is chosen; non-zero `referralFee` hard-rejects with `PARTNER_FEE_UNAVAILABLE` until partner fees ship; integer `referralCode` maps to the `odos<code>` referral code in appData. String error codes plus api-dx numeric band codes (compat-specific numbers at 49xx/59xx, outside the frozen backend table). Optimism (10) + Unichain (130) enabled, other chains behind config. New blocking CI job, `compat-api-deploy.yml` (mirrors mcp-deploy.yml), and a "Migrating from Odos" docs page with the full request/response mapping tables.
- `@ophis/sdk` 0.3.0 (api-dx SDK work packages of the Odos extraction program): new `errors` module with typed classes for the frozen v1 numeric error-code bands (1xxx-5xxx): `OphisApiError`, `OphisUnroutableError` (unroutable is an answer, not a failure; never retried), `OphisRateLimitError` (429 never retryable in-call), plus `parseOphisApiError` with `traceId` capture from the `X-Trace-Id` header and error bodies, `isUnroutable` / `isRetryable`, and `withOphisRetry` (jittered exponential backoff honoring `Retry-After` from the 3xxx upstream band; unknown codes preserve the raw payload so codeless CoW-hosted chains and pre-code backends degrade gracefully). New `preflight` module: `ophisPreflight` batches `balanceOf` + `allowance` through Multicall3 in one `eth_call` (`isPreflightReady` / `approvalNeeded` semantics, spender defaulting to the per-chain vault relayer) behind a zero-runtime-dependency structural `OphisMulticallClient` interface that any viem `PublicClient` satisfies as-is (viem remains a peerDependency). Fail-closed throughout: a failed multicall throws `OphisPreflightError`, never reports ready; per-token read failures zero the value and pin readiness false; and when the client exposes `getChainId` (viem `PublicClient` does) the preflight verifies the connected chain matches the requested `chainId` and throws on mismatch, closing the wrong-chain fail-open where shared deterministic addresses (the canonical vault relayer on 11 chains, OP-stack WETH at `0x4200...0006`) make a cross-chain read look like a plausible ready (clients without `getChainId` proceed unchecked and trust the `chainId` argument). `withOphisRetry` additionally jitters on top of the `Retry-After` floor so synchronized clients do not stampede the recovering upstream on the same second, and validates `minDelayMs` / `maxDelayMs` / the `random()` output as non-negative finite numbers.
- `@ophis/agent-skills` npm packaging for the skill family: `packages/agent-skills` commits no skill content; `scripts/package-agent-skills.mjs` stages the served family at build time (byte-for-byte copies, digests verified against the hosted discovery manifest, LICENSE notice + policy block presence enforced, package version pinned to the umbrella skill version) and the tag-driven `.github/workflows/skills-release.yml` (`skills-v*`, provenance-attested, same `NPM_TOKEN` mechanism as `sdk-release.yml`) publishes it. Nothing publishes until that tag is pushed. The agent-skills CI static lane now also runs the staging script as a release build dry run.
- Ophis agent-skill family at `/.well-known/agent-skills/ophis/`: umbrella `SKILL.md` with a machine-readable per-chain policy block (pinned settlement + vault-relayer addresses, EIP-712 domains, orderbook hosts, slippage latches) plus five sub-skills (`ophis-quote`, `ophis-swap`, `ophis-order-status`, `ophis-cancel`, `ophis-surplus-report`) for shell-capable agents (curl/jq/cast). Discovery manifest digests regenerated; `swap-via-ophis` kept URL-stable with a cross-link. New CI gates: `scripts/check-agent-skills-invariant.mjs` (security.yml) pins the skill policy against `@ophis/sdk` and the backend cancellation type hashes; `scripts/test-agent-skills.mjs` + `.github/workflows/agent-skills-ci.yml` add static checks and a scheduled live read-only canary.

### Changed
- `@ophis/sdk` `buildOphisFullAppData` / `buildOrder` gained an optional `extraPartnerFees` / `partnerFees` parameter (additive, default-off): extra integrator-priced CIP-75 Volume entries append to `metadata.partnerFee`, serialized as an ARRAY (Ophis default first) the app-data `Validator` accepts. With no extras the field stays a single object, byte-identical to before (the compat surface's `referralFee` mapping is the first consumer; the MCP re-export and all call sites are unchanged).
- `@ophis/agent-skills` packaging hardening (review follow-up on the initial packaging): the release tarball-content gate moved out of `skills-release.yml` into the shared `scripts/verify-agent-skills-tarball.mjs`, its expected file list now derived from the staged manifest instead of a hand-maintained 12-file list, and the agent-skills CI static lane runs the same gate, so a pack-list change fails at merge time instead of breaking the release after the tag. `prepack` added beside `prepublishOnly` (a clean-checkout `npm pack` previously emitted a two-file tarball with no skills). The staging script now wipes `packages/agent-skills` staging BEFORE reading any input, so a crashed run can never leave stale staged artifacts. The umbrella policy block is now validated at its exact frontmatter path `metadata.openclaw.web3.policy` (non-empty `allowedContracts`) via a new fail-closed frontmatter tree parser (`scripts/lib/frontmatter.mjs`, also adopted by `check-agent-skills-invariant.mjs`), replacing regex checks that kept passing with the block moved to a wrong path. Package README install snippets now replace the destination on upgrade instead of nesting a second `ophis/` copy.
- WP0 of the Odos extraction program: the pure order-build core (`deterministicStringify`, `buildOphisFullAppData`, `buildOrder`, `assertLimitWithinSlippage`, `extractQuoteAmounts`, the amount/address guards, `ORDER_TYPED_DATA_TYPES`, `APP_DATA_VERSION`, `MAX_SLIPPAGE_BIPS`) moved from `apps/mcp-server/src/ophis.ts` into `@ophis/sdk` (`packages/sdk/src/order-build.ts`). The MCP re-exports the same surface (`buildOphisFullAppData` under its old local name `buildOphisAppData`), so behavior and every call site are unchanged. `@ophis/sdk` now declares `viem` as a peerDependency (appData hashing + address checksumming); the rest of the SDK stays dependency-free.
- Rebate pool resized from 50% to 21.25% of net WETH fees (`POOL_SPLIT_BPS` 5000 → 2125) so the protocol retains ~55% of gross blended after CoW's hosted-chain cut. Tier weights and the pari-mutuel distribution are unchanged; only the pool size shrinks.

### Security
- Bumped `shell-quote` to 1.8.4 (pnpm override) to resolve GHSA-w7jw-789q-3m8p (critical; transitive build-tool dep via `launch-editor`, not browser-reachable).
- Extended the tier-table cross-workspace invariant CI gate to cover the cowswap-frontend mirror (now all three), with numeric normalization so `0.5`/`0.50` and `5_000`/`5000` no longer cause a false mismatch.
- Triaged the 3 open Dependabot alerts surfaced by the agent-plugins dependency tree (#688). `bn.js` <4.12.3 (GHSA-378v-28hj-76wf, medium) fixed via SCOPED pnpm overrides (`number-to-bn>bn.js`, `ethjs-unit>bn.js` → `^4.12.3`) — scoped, not blanket, to avoid downgrading the ethers-v5 / web3-utils `bn.js@5.2.3` line (which a tree-wide override would break). `bigint-buffer@1.1.5` (GHSA-3gc7-fjrx-p6mg, high) and `elliptic@6.6.1` (GHSA-848j-6mx2-7j84, low) dismissed with reachability rationale: neither has an upstream patch, and both reach the tree only via the `@coinbase/agentkit` / `@goat-sdk` peer+dev dependencies, which the published `@ophis/*` packages do not bundle (their runtime closures are ethers-v6 / viem → `@noble`). The vulnerable Solana (`bigint-buffer.toBigIntLE`) and ethers-v5 (`elliptic` ECDSA) code paths are unreachable from any shipped artifact. Audit trail per CVE in the dismissal comments.

### Added
- Issue + PR templates, `CODEOWNERS`, README badges, custom social preview ([#315]).
- Org-level profile README at [`ophis-fi/.github`](https://github.com/ophis-fi/.github).
- Bungee affiliate rev-share routing (sdk-bridging integration) ([#307]).
- All-chain partner-fee emission restored across the 14 served chains ([#306]).
- Cloudflare Turnstile activation on the `/contact` form (production-verified) ([#310] [#311] [#312]).
- Richer contact form with structured dropdowns + Telegram bridge + honeypot ([#308] [#309] [#310]).

### Changed
- Dependency security overrides closed 19 Dependabot alerts in one sweep; took
  the open-alert count from 202 to 0 via bumps + reasoned dismissals ([#314]).
  Notable: replaced a stale `tar: ^6.2.1` override that was forcing a vulnerable
  major; updates to `tmp`, `esbuild`, `protobufjs`, `rollup`, `yauzl`,
  `webpack-dev-server`, `on-headers`, `follow-redirects`, `svgo`, `minimatch`,
  `ip`, `@babel/plugin-transform-modules-systemjs`.
- Brand sweep: coral → saffron as the canonical primary; brand sheet font set to
  Geist ([#300] [#301] [#302] [#305]).
- Repo housekeeping: removed dead globe loader + `d3-geo`/`topojson-client`,
  retired the unused `EntityChip` component ([#303] [#304]).

### Fixed
- Formspree contact endpoint wired to the real public form ([#309]).
- Workflow comment drift in `cloudflare-deploy.yml` referencing a deleted
  `FORMSPREE_TURNSTILE_SECRET` ([#313]).

### Security
- Dismissed 169 alerts in `contracts/yarn.lock` + `contracts/pnpm-lock.yaml` as
  `not_used` — vendored hardhat toolchain is not installed by CI; production
  contracts build via `forge` (Foundry). Dismissed 7 unfixable runtime alerts
  with provably-bounded reachability rationale (`ip`, `elliptic`,
  `web3-core-method`, `web3-core-subscriptions`, `request`, `rand` x2). Audit
  trail per CVE recorded in dismissal comments.

## [0.2.5-phase2-5] — 2026-05-03

Phase 2.5 — Public Launch PASS (1 deferred item).

- Optimism mainnet is the live chain (settlement, solver, partner fee).
- HyperEVM (999) + MegaETH (4326) contracts deployed; backend stacks paused.
- Public docs portal at [docs.ophis.fi](https://docs.ophis.fi).
- Explorer at [explorer.ophis.fi](https://explorer.ophis.fi).
- SDK published as `@ophis/sdk` (partner-fee config, supported-chain registry,
  agent-safety helpers).

## [0.2-phase2] — 2026-05-03

Phase 2 — Retail Engineering Substrate PASS.

- Backend audit closed (32 → 3 deferred); rebate-indexer + partner-fee runtime
  hardened.
- Frontend audit closed; persisted-state hydration guards added.
- Cross-stack invariants enforced in CI (partner-fee, tier table, eRPC
  upstream-IDs).

## [0.1.5-phase1-5] — 2026-05-03

Phase 1.5 — Monetised Frontend PASS.

- CIP-75 `priceImprovementBps` partner fee shipped.
- Tier table + rebate ledger wired through to the frontend.

## [0.1-phase1] — 2026-05-03

Phase 1 — PARTIAL PASS.

- First end-to-end intent → quote → settlement loop on Optimism.
- Natural-language `/api/intent` parser shipped.

## [0.0-phase0] — 2026-05-02

Phase 0 foundation complete.

- Frontend deployed at `ophis.fi`.
- Backend build green; baseline solver operational.
- CoW Protocol subtrees vendored: `cowprotocol/cowswap`, `cowprotocol/services`,
  `cowprotocol/contracts`.

[#300]: https://github.com/ophis-fi/ophis/pull/300
[#301]: https://github.com/ophis-fi/ophis/pull/301
[#302]: https://github.com/ophis-fi/ophis/pull/302
[#303]: https://github.com/ophis-fi/ophis/pull/303
[#304]: https://github.com/ophis-fi/ophis/pull/304
[#305]: https://github.com/ophis-fi/ophis/pull/305
[#306]: https://github.com/ophis-fi/ophis/pull/306
[#307]: https://github.com/ophis-fi/ophis/pull/307
[#308]: https://github.com/ophis-fi/ophis/pull/308
[#309]: https://github.com/ophis-fi/ophis/pull/309
[#310]: https://github.com/ophis-fi/ophis/pull/310
[#311]: https://github.com/ophis-fi/ophis/pull/311
[#312]: https://github.com/ophis-fi/ophis/pull/312
[#313]: https://github.com/ophis-fi/ophis/pull/313
[#314]: https://github.com/ophis-fi/ophis/pull/314
[#315]: https://github.com/ophis-fi/ophis/pull/315

[Unreleased]: https://github.com/ophis-fi/ophis/compare/v0.2.5-phase2-5...HEAD
[0.2.5-phase2-5]: https://github.com/ophis-fi/ophis/releases/tag/v0.2.5-phase2-5
[0.2-phase2]: https://github.com/ophis-fi/ophis/releases/tag/v0.2-phase2
[0.1.5-phase1-5]: https://github.com/ophis-fi/ophis/releases/tag/v0.1.5-phase1-5
[0.1-phase1]: https://github.com/ophis-fi/ophis/releases/tag/v0.1-phase1
[0.0-phase0]: https://github.com/ophis-fi/ophis/releases/tag/v0.0-phase0
