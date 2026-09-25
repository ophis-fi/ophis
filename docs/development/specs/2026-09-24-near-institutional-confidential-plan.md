# NEAR Intents: public confidentiality and institutional controls

Created 2026-09-24; solver verification updated 2026-09-25. The linked NEAR documentation was checked on September 24. The working branch is `fix/solver-address-attribution-20260925`, based on production/main `f518fe2a`, which now includes Arc. This is an implementation plan; the only implementation in this change is the solver identity fix.

## Product split

| Capability | Public Ophis users | Approved institutional customers |
| --- | --- | --- |
| Confidential swaps on supported NEAR routes | Available without a B2B subscription | Available, subject to the customer's policy |
| Upstream compliance and security checks | Remain in effect | Remain in effect |
| Customer-specific AML policy, review and evidence | No institutional dashboard | Contracted B2B capability |
| SHIELD incident monitoring, route restrictions and reporting | Normal service-status messages | Contracted B2B capability |
| SHIELD incident submission | No | Separately authorized operators only |

The paid offer is Ophis's policy enforcement, operational controls and evidence. Do not imply that non-paying users bypass NEAR's screening. NEAR documents screening on integrated quote flows, with coverage varying by path; it does not document a general-purpose AML scoring API that we can assume is available. [Risk & Compliance](https://docs.near-intents.org/security-compliance/risk-and-compliance)

SHIELD is NEAR's incident/security policy system. It is separate from shielding assets into a confidential balance, and it is not insurance. Its current coverage includes integrated quote-time decisions; some broader enforcement remains in rollout. [SHIELD status and scope](https://docs.near-intents.org/security-compliance/proactive-intents-security)

## Existing implementation to reuse

- `apps/frontend/apps/cowswap-frontend/src/tradingSdk/bridgingSdk.ts` already sets `confidentiality: 'basic'` when `REACT_APP_NEAR_API_KEY` is present. This is source-level behavior, not proof of successful confidential settlement on every advertised route.
- `ophisNearIntentsProvider.service.ts` already injects the mode, preserves referral/app fees, verifies deposit-address attestation, and rejects a response that does not echo the requested confidentiality. Its tests cover basic/advanced and rejected public downgrades.
- `modules/tradeQuote/services/fetchAndProcessQuote.ts` uses the bridge SDK's best-quote selection. Across and NEAR are both available: requesting confidentiality from NEAR alone does not make the selected route confidential. Same-chain swaps currently take the ordinary orderbook path.
- `entities/bridgeOrders` already persists bridge progress. Extend this with the selected mode and supported privacy scope so history and reloads do not lose the user's choice.
- Existing Pages functions can host a narrow NEAR API gateway. The existing partner API and PostgreSQL database can hold institutional memberships, policies and records; `apps/rebate-indexer/src/affiliate/partnerAuth.ts` supplies a wallet-proof pattern. Affiliate status itself must not grant institutional access.

## Delivery sequence

### 0. Correct solver identity — implemented in this branch

The reported order is on Arc (chain 5042). Its live order-status response names `uniswap-v3` and records `sell: 2000000`, `buy: 1740907`: 2 USDC for 1.740907 EURC. Arc and its Uniswap v3 lane were absent from the shared frontend solver registry, so both the metadata hook and the completion-card fallback lacked that identity.

Register that lane only on Arc and label it **Uniswap v3**, with the existing **Ophis-operated routing lane** description. Reuse the existing registry and fallback; do not change CMS scoping or invent address-to-lane attribution. The earlier, broader CMS/fallback changes were removed once the exact order established the root cause.

The regression replays the observed winning entry and verifies its amounts remain unchanged. Arc's September 25 release added KyberSwap; register both current lanes and compare them against the renderer's shared `lanes` list without executing the release renderer.

Cross-chain verification also found that CoW-hosted APIs return deployment addresses, not CMS solver IDs. Fetch and retain the CMS network address, then resolve it only within the current chain and environment. Keep one canonical map entry per solver so counts do not increase. Conflicting or absent mappings remain unknown. Bump the raw CMS cache version so address-less cached responses are refreshed.

Evidence: [reported order status](https://arc-mainnet.ophis.fi/api/v1/orders/0xc32f04a27e91ea7da7395af79e4a1f74136d60c28c63e4cbd548e61cc6d886fa0494f503912c101bfd76b88e4f5d8a33de284d1a6ab53d7c/status). Its trade record identifies settlement transaction `0xba2f98b61df1c265f1f3d5e795293085523d2146c664bd2a5e8670c137e0685e`. The supplied `0xc7da91…15f2fe3` value is the order's app-data hash, not its settlement transaction hash.

### 1. Confirm provider access and move secrets behind the server

1. Confirm the existing 1Click partner account's basic/advanced access, supported routes, errors, fees, latency and privacy guarantees. Start the public offer with basic mode; do not invent a difference in guarantees between the two enum values.
2. Request a separate SHIELD key with `key_type: SHIELD` and read access. Begin with `GET https://shield.chaindefuser.com/incident`; incident writes require additional support-granted permissions. Confirm the exact scopes granted to Ophis. [Shield Incident API](https://docs.near-intents.org/security-compliance/shield-incident-api)
3. Confirm whether the partner agreement exposes detailed AML decisions and evidence, which addresses/flows are covered, and what may be retained or shown to customers. If detailed screening is unavailable, obtain a contracted screening provider before advertising customer-configurable risk scoring.
4. Add an allowlisted, rate-limited server gateway for the required NEAR operations. Retain quote and attestation validation. The pinned SDK takes an API key but does not expose a general NEAR base-URL option: adapt the existing provider's API methods or use a verified SDK upgrade, rather than assuming an unsupported option.
5. Remove the partner secret from browser builds and rotate the old credential after migration. Keep SHIELD, AML and any user-session credentials separately scoped; never add privileged scopes to a browser-delivered token.

Exit: access/coverage matrix recorded, secrets server-side, ordinary quotes still work through the gateway, and upstream failures produce explicit errors without relaxing requested protections.

### 2. Ship confidential swaps for everyone

Use the distribution-channel path: ordinary external-chain deposits and withdrawals plus `confidentiality: 'basic'`. The market-maker relay in the supplied link is unnecessary for this first release. [Confidential swap quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps)

1. Add a visible confidential choice and a confirmed-mode label to quote, review, progress and history. No institutional enrollment gate. Only offer it where the complete route is supported.
2. Pass privacy mode through quote parameters and cache keys. Changing mode invalidates the previous quote and triggers a new one. Reject stale responses from a previous mode/account/route.
3. When confidentiality is requested, limit quote selection to eligible NEAR routes and validate the final chosen quote again before signing/deposit. A public Across route, direct swap, retry or SDK fallback must never silently satisfy this request.
4. Preserve the existing no-downgrade guard, amount/deadline checks, fee attribution and attestation verification. Treat an echoed mode as a requested service property, not an independent cryptographic proof of confidential execution; verify the provider's supported evidence and current signed fields.
5. Show the privacy boundary accurately: external-chain transfers remain public, and a source CoW swap leg can remain public. Do not advertise the entire route as confidential when only its NEAR leg is. FAR is permissioned and uses a private PoA bridge; avoid claims of anonymity from operators or universal unlinkability. [Confidential architecture](https://docs.near-intents.org/integration/market-makers/confidential-intents)
6. Exclude confidential order details, linked addresses, amounts and deposit identifiers from analytics, session replay, public feeds and share links. Keep only the private state needed for recovery; sanitize error reports and define retention.
7. Test a supported route end to end, expiry/refund, provider outage, downgrade rejection, mode changes, competing Across quotes, reload recovery and mobile wallets. Use documented test facilities first; production-funded canaries need separately authorized funds.

Exit: public users can select confidentiality, see its actual scope, and complete or recover a supported swap. Unsupported paths are unavailable in this mode with a clear explanation.

### 3. Build the institutional AML + SHIELD pilot

Start with a small, manually onboarded customer list and a fixed policy schema. Reuse existing server/database infrastructure; no custom rules engine or separate compliance microservice for the pilot.

1. Store customer membership, enabled capabilities (`aml`, `shield`), allowed networks/assets, policy version and retention settings server-side. Derive customer identity from authenticated membership or a scoped API credential, never a client-supplied tier flag. Provision institutions independently of affiliate/referral programs.
2. Use one authoritative preflight for institutional quotes and execution authorization. Screen the applicable source, recipient and refund addresses; bind approval to customer, wallet, exact route/amount, privacy mode, expiry and policy version. Re-check before funding/signing when approval expires or policy/incident state changes. Baseline provider screening remains mandatory.
3. Record separate screening and SHIELD results plus the resulting Ophis action: allow, reject, temporarily unavailable, or review required. Upstream rejection cannot be overridden by an Ophis reviewer. Customer-policy reviews need an authorized role, a reason and an audit event.
4. Read and cache SHIELD incidents with a bounded freshness window. Match chain/bridge/token/address and direction against each route. Apply Ophis's documented customer policy conservatively; an `operational` incident feed alone is not proof that a particular transaction passed AML or a SHIELD evaluation endpoint.
5. On stale incident data, unavailable mandatory screening, malformed responses or missing entitlements, stop issuance of new institutional execution approvals. Distinguish outages from risk rejections. Continue tracking already-funded swaps and recovery/refunds; do not strand users by blocking the recovery path.
6. Enforce customer restrictions before route selection, including any alternative provider. A rejected institution request must not fall back automatically to the retail flow or a less-protected route. Controls govern Ophis's service; do not claim they can prevent a customer using an external service independently.
7. Store request/quote reference, decision, reason category, timestamps, provider reference, policy version and eventual outcome in a tenant-scoped append-only audit table. Restrict sensitive evidence, encrypt it at rest and define retention/deletion with the customer. Confidential trades stay private to authorized parties.
8. Add a minimal institutional dashboard: enabled protections, route availability, review queue, own-customer decision history and CSV export. Start with manual invoicing for the pilot; subscriptions and self-service onboarding can follow demand. Validate KYB, reporting, contractual and jurisdictional responsibilities with the institution before launch; quote screening alone is not a complete compliance program.

Exit: tests reject cross-customer access, forged entitlements, replayed/expired approvals, changed recipients/routes, stale incidents and provider failures. Pilot users can retrieve an auditable decision and see delayed/rejected states accurately. Verify recovery under an incident and document exactly which paths are protected.

### 4. Add scoped SHIELD writes and embedded confidential accounts only when needed

SHIELD writes should follow a read-only institutional pilot. Restrict `POST /incident` to explicitly granted scopes, approved operators and audited incident actions. Do not translate a customer's local trading pause into a platform-wide incident. Follow the provider's authorization process for incident resolution; no undocumented admin endpoints.

If users need persistent confidential balances, add the embedded-account path separately: `CONFIDENTIAL_INTENTS` deposit/recipient/refund types, signed intents, balance display and recoverable withdrawals. Partner JWTs do not authorize access to a user's private balances/history; wallet-proven User-Session authentication is separate. Confirm history access before promising it. [User authentication](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication), [account history availability](https://docs.near-intents.org/api-reference/account/get-transaction-history)

Only operate a confidential market-making solver if Ophis needs to supply its own private liquidity. That entails FAR balances, private relay access, versioned nonces, swap/recovery intents and settlement/reconnect handling. It is not required to offer confidential swaps through 1Click. [Market-maker integration](https://docs.near-intents.org/integration/market-makers/confidential-intents)

## Release order and open dependencies

Release the solver fix independently using the existing deployment workflow and its production build settings. Arc and its newer bridge/routing changes are now in main; the solver branch includes them. A branch deployment must still be integrated into main before a later main deployment can supersede it safely.

Complete provider-access validation and the server credential boundary, then deliver public confidential routing. Institutional policy and incident monitoring can be developed alongside that work, but remain restricted to the approved pilot until coverage and failure behavior are verified. Embedded accounts and Ophis-operated private liquidity are separate later milestones.

Open dependencies: NEAR's access grants and flow-specific AML evidence; confirmed basic/advanced behavior; first institutional customer policies and retention requirements; an approved funded canary for production settlement verification. These do not block the solver fix or this plan.

## Validation of this change

- Solver regression: the original Arc tests reproduced the missing registry entry. Eleven additional chain cases reproduced the address/ID mismatch before the new lookup. All 56 tests in `useSolversInfo`, `useOrderProgressBarProps` and `ophis/solvers` pass, including chain/environment isolation, ambiguity and unchanged counts.
- The solver-registry invariant passes for Optimism, Unichain, Robinhood and Arc, including its extractor self-test.
- Frontend TypeScript check and changed-file ESLint pass. No dependencies added; frozen dependencies were installed offline in the isolated worktree.
- Live order-status samples were replayed through the source lookup for 14 mainnets plus Sepolia. Names resolved on all 15. Arbitrum/Base samples retained unknown entries for `0x8f5835e9d756c9bd934bce527157a4b0ef3c5cb7` (CMS deployment only on Ethereum) and `0xdd5aecdd8ba8498706e2583f6e2ff90e08e1c01b` (CMS deployment only on Arbitrum staging). This is not a claim that every solver has complete metadata.
- TypeSafe/Jev (`jev-1.13.0`) reviewed the address lookup's chain/environment scope, ambiguity handling, solver counts and cache update. These model judgments supplement the tests, not production proof.
- Deployment pending at this checkpoint. No new funded swaps or institutional-provider writes were performed.
