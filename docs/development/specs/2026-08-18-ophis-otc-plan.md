# Ophis OTC: UX, development, and deployment plan

Status: planning only. No transaction integration or production release is authorized by this document.

## Decision summary

Ophis OTC will be an Ethereum-only, explicitly escrowed OTC product surface. It must not appear as a hidden route in the normal swap widget and must not weaken or globally apply restrictions to existing Ophis trading flows.

The first delivery is UI/UX and read-only discovery. Contract writes remain feature-flagged off until implementation, fork testing, security review, and explicit release approval are complete.

No provider-specific or paid RPC is a protocol requirement. Ophis can use any standards-compliant Ethereum JSON-RPC endpoint. Version 1 is designed not to require archive RPC access.

## Product boundaries

### In scope

- Ethereum mainnet only.
- Browse active fixed-price OTC orders.
- View exact onchain terms and escrow disclosures.
- View a connected maker's orders.
- Later, behind separate release gates: create, approve, fill, cancel, and ETH/WETH convenience flows.
- Strict, flow-specific token policy.
- Ophis-owned indexing and direct Ethereum reconciliation.

### Out of scope

- Solver or Settlement liquidity integration.
- Routing OTC orders through the normal Swap action.
- Arbitrary ERC-20 support.
- Partial fills.
- Maker-side onchain expiry, which the deployed contract cannot enforce.
- Cross-chain deployment or contract replication.
- Historical analytics in the first release.
- Copying the external project's AGPL frontend or contract code.

## Milestone A: UI/UX first

Milestone A uses mocked or read-only data and contains no contract-write capability.

### Navigation and information architecture

- Add a distinct `OTC` entry under the trading navigation.
- Display an `Ethereum` network badge and do not present a misleading multi-chain selector.
- Use three product views:
  - `Browse`: active allowlisted orders.
  - `My orders`: connected maker's active and resolved orders.
  - `Create`: visible in design prototypes but disabled until transaction development is approved.
- Keep the normal Swap, Limit, and TWAP experiences unchanged.

### Required disclosure hierarchy

The page header must state, in plain language:

- assets are deposited into an external immutable escrow contract;
- creating and cancelling orders costs Ethereum gas;
- orders do not expire onchain;
- fills are all-or-nothing;
- public transactions may be raced;
- only Ophis-reviewed assets are supported in this interface.

The primary warning should be visible without opening a tooltip. Detailed risks can use an expandable panel.

### Browse view

Each row or mobile card displays:

- exact amount paid and received, with USD context when available;
- effective exchange rate and optional deviation from a reference price;
- token symbols plus full addresses in the detail view;
- maker name when verified, shortened address, copy action, and explorer link;
- order ID, age, active state, and escrow badge;
- `Verified onchain` only after direct RPC reconciliation;
- a visible unavailable/stale state rather than silently retaining old data.

Filters are limited to supported tokens, pair, maker, and order ID. Unknown tokens are omitted from the actionable list rather than globally disabling them elsewhere in Ophis.

### Order detail and review

- Treat indexed data as discovery data only.
- Fetch the full order directly from Ethereum when opening the detail view.
- Before showing an actionable review, require exact equality for maker, active state, both token addresses, and both amounts.
- If indexed and onchain data differ, disable the action and show `Order data changed — refresh required`.
- Display the contract address and explorer link in the technical details section.

### Transaction interaction states for the later write milestone

Every onchain action owns its own state machine:

1. Connect wallet.
2. Switch to Ethereum.
3. Review or approve the exact amount.
4. Submit the action.
5. Wait for onchain confirmation.
6. Reconcile the resulting order state.

Approval, create, fill, and cancel buttons must not share a generic loading state. Buttons disable immediately and remain disabled through confirmation and state refresh. Wallet rejection, RPC failure, raced fills, stale orders, and contract custom errors receive human-readable inline messages.

### Accessibility and responsive acceptance criteria

- Full keyboard navigation and visible focus treatment.
- Status is never communicated through color alone.
- Screen-reader labels for token icons, addresses, copy buttons, and transaction state.
- Mobile cards preserve exact amounts, risk disclosure, and the primary action without horizontal scrolling.
- Reduced-motion support for loaders and state transitions.
- Light and dark themes use semantic Ophis design tokens.

## Architecture

### Contract manifest

Maintain a reviewed Ethereum manifest containing:

- chain ID;
- deployed contract address;
- deployment/start block;
- expected runtime code hash;
- canonical WETH address;
- independently defined minimal ABI;
- enabled transaction selectors;
- token-policy profile identifier.

At startup and periodically thereafter, compare `eth_getCode` against the expected runtime hash. A mismatch disables all OTC actions.

### RPC and indexer design

No archive RPC is required for version 1.

Bootstrap current state as follows:

1. Read `nextOrderId()` from the deployed contract.
2. Enumerate IDs from zero to `nextOrderId - 1` through bounded `getOrders` batches.
3. Persist the returned maker, active flag, token addresses, and exact amounts.
4. Start event ingestion from a persisted recent-block checkpoint using small `eth_getLogs` windows.
5. Reconcile active orders periodically through `getOrders` so a missed event cannot leave an actionable stale order.
6. Use the public third-party subgraph only as an optional discovery or recovery hint, never as transaction authority.

This bootstrap recovers every order's current terms without historical state. Version 1 does not promise complete filled-versus-cancelled history because that distinction requires historical events. If complete historical analytics become a requirement, add a separately reviewed history source or a one-time verified event import.

The frontend may use the connected wallet provider for submission and final preflight reads. Read-only discovery must also work without a wallet through Ophis's configured network provider.

### Token policy

Create a separate `OTC_ESCROW` profile. It applies only to this module.

Initial candidates are canonical Ethereum WETH, USDC, and DAI. ETH is exposed only through the contract's reviewed WETH convenience functions. Final inclusion requires a token-by-token review of transfer behavior, upgrades, pausing, blacklisting, decimals, and custody risk.

Reject:

- fee-on-transfer and sender-tax tokens;
- rebasing tokens;
- unknown or unreviewed proxies;
- tokens that can report successful transfers without moving balances;
- tokens with unsupported callbacks or non-standard approval behavior;
- any order where either side is outside the active OTC policy.

Policy enforcement occurs in discovery, review, and every write sink. A bypassed selector or injected state must still fail at the transaction service boundary.

## Development milestones

### A. UX shell and prototypes

- Add the isolated route and navigation entry behind a disabled feature flag.
- Build Browse, My orders, order detail, empty, loading, stale, error, and disclosure states.
- Use fixtures only.
- Complete desktop, mobile, keyboard, and screen-reader review.

Exit gate: product approval of the complete non-transactional experience.

### B. Read-only Ethereum integration

- Add the pinned manifest and minimal ABI.
- Implement current-state bootstrap and checkpointed event ingestion.
- Implement code-hash verification and direct order reconciliation.
- Apply `OTC_ESCROW` policy without affecting normal Ophis token selection.
- Add indexer-lag and RPC-degradation states.

Exit gate: deterministic read-only tests, successful mainnet shadow run, and zero indexed/onchain mismatches left unexplained.

### C. Write-path development, feature flag off

- Implement create, cancel, fill, ETH-to-WETH fill, WETH-to-ETH receive, and unwrap-cancel paths.
- Use a short nonzero taker deadline.
- Approve only the exact required amount.
- Use wallet atomic batching only when validated wallet capabilities explicitly support it.
- Re-read order state and simulate immediately before wallet submission.
- Surface unused allowances after failed or raced fills and provide a safe revocation path.

Exit gate: all paths pass local-mainnet-fork tests and transaction controls remain disabled in production.

### D. Security and quality gates

- Unit tests for ABI decoding, tuple ordering, amount conversion, token policy, stale data, and error translation.
- Property tests for indexer reconciliation and state transitions.
- Mainnet-fork tests for create, fill, cancel, races, expired taker deadlines, rejected approvals, and unsupported tokens.
- End-to-end tests for injected wallets and validated atomic-capable wallets.
- Reorg and RPC outage recovery tests.
- Accessibility and responsive QA.
- Dependency/code-hash verification in CI.
- Trail of Bits, Verity, and Pashov skill reviews must all be green.
- Resolve every P0/P1 and obtain explicit disposition for lower-severity findings.

Exit gate: all required reviews green and explicit owner approval to proceed.

### E. Staging and canary

1. Deploy read-only staging with transaction controls absent.
2. Run shadow indexing and reconciliation against Ethereum.
3. Enable write controls only in a forked or isolated test environment.
4. Prepare a production canary configuration with strict tokens and configurable per-action exposure limits.
5. Request explicit approval before any mainnet write-enabled deployment.

No automatic release follows test completion or review approval.

### F. Production operations

Monitor:

- RPC availability and latency;
- indexer checkpoint age;
- indexed/onchain mismatches;
- runtime code-hash mismatches;
- simulation and submission failure rates;
- raced fills;
- outstanding allowances after failed flows;
- token-policy rejections;
- escrow values exposed through the Ophis interface.

The rollback mechanism is the Ophis feature flag and route removal. Ophis cannot pause or modify the external immutable contract, so the UI must fail closed when monitoring or verification is unhealthy.

## RPC requirement decision

Required JSON-RPC methods are standard Ethereum methods: `eth_chainId`, `eth_blockNumber`, `eth_getCode`, `eth_call`, `eth_estimateGas`, `eth_getLogs`, transaction submission through the wallet, and transaction receipt reads.

There is no dependency on a named paid provider, proprietary API, or archive state query. The current Ophis network configuration already supports a keyless public Ethereum endpoint and an environment override for supervised infrastructure.

Operational caveat: public endpoints have rate and history-window limits. The current keyless endpoint serves present-state contract calls but restricts older log ranges. The bootstrap and reconciliation design above avoids making archive access a launch dependency. A paid or self-hosted provider remains an optional reliability upgrade, not a functional requirement.

## Release authority

- No production deployment, feature-flag enablement, contract approval, or mainnet transaction is authorized without explicit owner approval.
- Security-review completion is necessary but does not itself grant release approval.
- Work must be developed in an isolated branch or worktree and must not overwrite unrelated local changes.
