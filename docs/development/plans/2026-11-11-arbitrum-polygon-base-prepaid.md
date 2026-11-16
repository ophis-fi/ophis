# Arbitrum and Base prepaid broadcaster release

Updated 12 November 2026. Branch `feat/railgun-arbitrum-polygon-base`, baseline `1678051911903a389f0f1d496faf0276fea38d3a`. This is an implementation and commissioning plan, not a record of public activation.

## Scope and authorization

Finish Arbitrum and Base using the existing paid Alchemy account, minimizing compute-unit consumption. Polygon is deferred at the owner's request. The owner approved Base reads through Alchemy, conditional submission through Base's official sequencer, and user-paid delegation setup. Because execution accounts rotate, setup is per fresh execution account, not once per wallet.

Reuse the existing ANON operator `0x001486E70A0c9291f5F55c68914eE0e4E4A604d4`, guard, native prepaid ledger, refund/recovery journal, encrypted custody, token discovery and wallet UI. Do not generate another operator wallet. Preserve Ethereum/BNB behavior, saved customer transactions and calendar-independent approvals. Do not modify Baal's Ethereum node or `apps/railgun/operator/proof-recovery/`.

Implementation and isolated testing are authorized. The owner subsequently funded the existing ANON operator on both L2s, provisioned a separate reviewed L2 custody helper and unlocked two concrete guard-deployment processes capped at 0.0001 ETH each. Those guard transactions succeeded and finality was attested. No customer service, merge, subscription or billing change is implied. Existing ETH/BNB helper scope and services remain unchanged. The proposed customer test budget and account selection remain separate.

## Implemented behavior

| Boundary | Arbitrum | Base |
| --- | --- | --- |
| Reads | Chain-pinned Alchemy application RPC | Chain-pinned Alchemy application RPC |
| Publication | Alchemy application RPC, no alternate fallback | Fixed `https://mainnet-sequencer.base.org`, `base_sendRawTransactionValidity` only |
| Account execution | Existing guarded EIP-7702 flow | User-funded delegation setup, then guarded type-2 transactions without an authorization list |
| Network budget | Gas limit × maximum gas price; Nitro includes parent-data costs in gas units | Execution maximum + conservative L1-data bound + maximum operator fee |
| Settlement | Exact finalized gas expenditure | Exact finalized execution + receipt L1 fee + historical operator fee |
| Public release | Blocked pending commissioning/live acceptance | Blocked pending commissioning/live acceptance |

Public native prepayment must be finalized and attributed to the authenticated owner before Ophis reserves or signs. Each attempt reserves its maximum network cost plus the existing 15% margin. Included failures consume the secured credit; unknown submissions retain their holds. Refunds reserve both customer principal and their own gas/margin. Cancellation cannot consume refund principal or exceed its secured allowance.

The shared L2 pipeline admits one unmined transaction and at most 20 canonically included but unfinalized attempts. The complete signed nonce prefix and receipts are verified against current canonical blocks. Backing equals actual native balance plus exact pending cash outflows; full customer liabilities and the protected reserve remain covered. No provisional margin is counted as earned revenue. Missing evidence, nonce gaps, reorgs, unknown spending and backing shortfalls block further signing. Finality is still required before new deposits become credit or existing attempt holds are released.

Base's conditional envelope pins four fee-state fields, both reviewed implementation addresses, activation flags and an expiry at most 100 blocks ahead. The saved unsigned transaction, total budget, conditions and signed body are immutable. Retries cannot refresh the conditions; a cancellation gets a separate bounded plan before signing. Base's L1Block v1.8.0 runtime was independently fetched from the public RPC and matched the reviewed hash. Future fee-rule upgrades require requalification. This protection depends on the sequencer enforcing its conditional API; it is not a consensus-level maximum total fee or a general MEV guarantee.

Base setup records are encrypted before submission. Exact sender, nonce, authorization, receipt and installed delegation are checked. Unknown outcomes do not trigger automatic resubmission; replacement/cancellation checks preserve recovery. Executable accounts are marked used before signed simulation disclosure, and account rotation is preserved after restoration. Native shielding uses a separate fresh account to avoid consuming a paid setup. All Base withdrawals use the bound guarded path; legacy COMMON proofs on other chains keep their existing recovery semantics.

## Cost controls

- Broadcaster discovery's modeled RPC cost falls from 700 CU to 100 CU per idle check (85.7% on that path, not a whole-account savings claim).
- Gateway block-height reads are cached/coalesced for 15 seconds, with backoff, persistent quota accounting and a 1 KiB request-body bound for that path.
- The existing 24 million CU / rolling 32-day cap, 100 weighted CU/s rate and 1,200 burst are unchanged. Gateway accounting does not cover direct operator RPC calls.
- Paid Alchemy historical/trace capability is opt-in per chain; free-provider fallbacks do not silently receive expensive requests. No billing or quota setting was changed.
- Quote routes use the existing aggregate call. Canonical receipt blocks are deduplicated and receipt batches bounded; no whole-history polling was introduced for ordinary discovery.
- Arbitrum's real-proof fork used 8,620 published CU under a 50,000-CU ceiling, with upstream writes denied. Base fee-plan preparation adds bounded storage/header reads; these security checks are not removed to reduce usage.

## Verification and evidence

Evidence is outside Git at `/Users/scep/ophis-railgun-evidence/multichain-prepaid-20261111/`.

Commissioning evidence from 12 November is in the sibling `multichain-prepaid-20261112/` directory. Both guards are at `0x5fa18eD9d36Fe8e6e30aCD4f894Df9C05913aB5E`, with chain-specific reviewed runtimes and successful Sourcify creation/runtime matches. Arbitrum deployment `0xeb3fb397b4fd608c0354a4fb570d424512e6dfb30aa366bff3506a29cb0b2cfb` cost 0.000007400682545443 ETH; Base deployment `0xbbfe536e6e7007fd4b8f2e224aa80aa622a206d5aa4792c26b28d91871f29216` cost 0.000001834152060501 ETH including its L1 and operator fees. Both receipts, exact runtimes and balances were attested at finalized state at 18:10:46 UTC. Both operator balances retain over 0.002 ETH; deployment processes exited successfully with restart disabled. The guards do not establish customer-flow acceptance.

A dedicated Alchemy app now isolates Arbitrum/Base credentials from existing shared applications, without changing billing. The public gateway cap is unchanged. Base's unavailable SDK history endpoint requires a bounded shared history fallback, now under local implementation and independent review. The frozen guard-deployment image predates that change; customer operation requires a rebuilt and reviewed image.

Completed checks include real RAILGUN SDK proofs and Arbitrum fork swap/withdrawal/failure accounting; Base backend tests for swap, withdrawal, refund, revert, all fee components, restart, expired plans and cancellation; client setup/replacement/restoration/rotation tests; and pipeline reorg, full-hold, capacity and backing regressions. An independent reviewer found the Base setup-then-shield bug; it was fixed and rereviewed. Exact final suite counts and the Base fork result belong in the release evidence, not an inferred pass here.

Live reads confirmed canonical SDK contracts, historical-state/trace capabilities, and one Arbitrum transaction whose sender debit exactly matched `gasUsed × effectiveGasPrice`, including its reported L1 gas units. Alchemy rejected Base's conditional method with empty params; no transaction was submitted by that probe. These reads and local forks do not establish live broadcaster acceptance.

ETHSkills and Ponytail guided implementation; Jev checked narrow plan/diff/CU claims earlier in this work. Independent money/recovery and transport/client review found and fixed concrete issues. Semgrep and CodeQL run on sanitized source snapshots; final findings, custom-model coverage and hash-drift verification are recorded in `static-final-review*`. No Solidity source changed; previous Slither/Pashov contract work is not represented as a new audit of this TypeScript integration. Independent exact-source review approved the local candidate; public launch remains conditional on commissioning and live acceptance. The production browser and gateway builds pass with matching source hashes.

Gitleaks 8.30.1 scanned the current tracked/unignored files and reachable Git history with redaction and extra Alchemy rules, without repository ignore suppressions. Initial findings were triaged: no active secret was identified in the current tree; two historical occurrences of a Dune credential are documented upstream as revoked. History still contains them; no history rewrite or credential authentication was attempted. A scan cannot prove absence of all secrets. Any previously exposed RPC app credentials require a dependency inventory and safe rotation before deployment; do not revoke a key used by another live app without coordinating that migration.

Base fork infrastructure encountered an unreachable public indexer from this Mac. Its bounded first attempt stopped at 49,980 CU before proof work. A test-only cached import then fetched 626 actual public logs in 60 wider queries plus three chain/head checks, costing 3,640 CU; it uses the installed SDK decoders and unchanged Merkle verification. This does not change production sync policy or establish public indexer availability for customers. Public history readiness must be verified before Base launch.

The original read-only commissioning preflight used 804 CU, with no signatures or writes, when both new-chain operators were unfunded. A later funded preflight removed the synthetic balance override and again matched both exact constructor runtimes. The deployment capital covers the proposed 0.001 ETH protected reserve and 0.001 ETH float, plus the approved 0.0001 ETH deployment allowance per chain. Separate customer test principal and fee credit remain unselected. Proposed total nonrecoverable live-test spend is 0.001 ETH per chain; the proposal alone grants no spending authorization. See `commissioning-preflight/approval-ready-packet.md` for the original proposal and the 12 November status for executed actions.

## Commissioning and release sequence

1. Freeze source, finish regression/type/build checks and exact-diff review. Record hashes and unresolved limitations.
2. Prepare separate Arbitrum/Base service state, ledger scope and Waku ports using the existing operator. Keep signing disabled. Inventory any shared RPC-key consumers and stage replacement credentials privately.
3. Verify current operator nonce/balance and canonical delegate code; estimate guard creation and the bounded test sequence. Produce explicit per-chain gas-price, transaction, daily-budget and protected-reserve limits with an owner-approved total commissioning budget.
4. Preserve the existing ETH/BNB custody helper; the separately provisioned L2 helper has exact scope 42161/8453. Owner unlocks apply only to the concrete staged process. Do not bypass that boundary or request a seed in chat.
5. Guard finality is attested. Initialize fresh native credit ledgers in reviewed isolated processes. Complete user-funded native prepayment, real swap, token/native withdrawal, fee settlement, refund and restart/recovery acceptance on each chain. Base's guard supplies positive conditional inclusion evidence; exclusion testing and customer execution are still outstanding. Local Anvil cannot establish native Nitro/OP fee semantics or sequencer enforcement.
6. Approve each chain separately only after its evidence passes. Merge/deploy under the owner's release authorization; verify public bundle, broadcaster identity, fee quotes, limits, refund/recovery availability and rollback procedure. A working selector, passing fork or funded gas address does not constitute launch.

## Primary technical sources

- [Arbitrum gas estimation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas)
- [Base network fees](https://docs.base.org/base-chain/network-information/network-fees)
- [Base conditional predicates](https://docs.base.org/specifications/build-transaction/predicates-and-safety)
- [Base L1Block v8.4.0 source](https://github.com/base/contracts/blob/v8.4.0/src/L2/L1Block.sol) and [storage layout](https://github.com/base/contracts/blob/v8.4.0/snapshots/storageLayout/L1Block.json)
- [Base fee formula](https://github.com/base/base/blob/v1.5.4/crates/common/l1-fees/src/params.rs) and [FastLZ implementation](https://github.com/base/base/blob/v1.5.4/crates/common/flz/src/flz.rs)
- [RAILGUN contract integration](https://docs.railgun.org/developer-guide/engine-1/getting-started-with-the-contracts)
