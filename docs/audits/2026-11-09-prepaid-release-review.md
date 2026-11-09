# Ethereum and BNB prepaid broadcaster — release overview

Date: 2026-11-09. This is an engineering review and release checklist, not production approval. It supersedes earlier readiness statements for the prepaid payment path. No merge, deployment, service activation or real payment is authorized by this document.

## Current readiness

The implementation and isolated proof tests establish a prepaid route that charges a user's reserved credit for included gas, including a reverted operation, and verifies owner-controlled refunds and native fee recovery. The read/trace adapter is implemented; its public read-only qualification and final static review passed. **Public release remains blocked** by exact-commit CI and actual ANON owner-wallet acceptance.

| Area | Current evidence | Remaining gate |
| --- | --- | --- |
| Ethereum and BNB prepaid accounting | Durable reservations, finalized payment attribution, replay protection, refund liabilities and native recovery implemented; real SDK proofs passed on isolated forks | Restricted live acceptance |
| Swap and withdrawal experience | Compact layout, chain/token logos, compatible custom ERC-20 selection, prepaid review/recovery, and native BNB withdrawal are part of the candidate | Final artifact smoke test and owner pilot |
| Operator money protection | Included success, revert and out-of-gas charges tested; liabilities remain backed after refund and collection | Actual owner quotes, usable private-note selection and native collection must meet the approved limits |
| Read-provider availability | The narrow BNB read/trace adapter passed historical pins, nested trace and recent simulation probes through public providers, following HTTP 403 failures on a supplied route | Approve and stage the qualified configuration; probe success is not an ongoing availability guarantee |
| Owner custody | Existing owner-controlled ANON identities and local unlock preserved; fee wallet remains view-only on the broadcaster | Review the exact staged configuration and unlock it locally for inspection/pilot |
| Release checks | Adapter-inclusive regressions, type checks, builds, image smoke, static analysis and focused review passed | Exact-commit CI and explicit release approval |
| Other chains | Existing development work is retained | Arbitrum and Polygon are not qualified by these Ethereum/BNB results. Base remains outside this release pending the owner's instruction |

Custom token support means compatible ERC-20 swap/withdrawal principal, subject to available routes and token validation. It does not mean every token has audited transfer behavior or every pair has liquidity. Network fee credit remains WETH on Ethereum and WBNB on BNB.

## Payment and recovery invariants

1. **Payment precedes operator spending.** The customer first pays the bootstrap transaction's gas from their public wallet and transfers private fee credit. Admission requires canonical finality, the verified private note and an authenticated claim. Ophis does not sponsor that initial payment.
2. **Authorization is specific and durable.** The signed request binds the owner, operation, chain, operator, fee identity, immutable ledger and sequence. Its maximum charge is reserved atomically before the operator signs. Finalized included gas is charged once within the accepted maximum and pricing terms; replay cannot create another charge or signature.
3. **Customer money is a liability.** Canonically unspent, accounted notes must cover all customer liabilities plus remaining earned value. Unclaimed transfers, donations and historical wallet surplus cannot become earnings. Recovery capacity must fit one accounted note, including outstanding maximum charges and queued refund obligations; aggregating notes across a future tree rollover is insufficient.
4. **Owner payments cannot silently consume customer backing.** Refunds and collections require an immutable intent, settled operator attempts, exact accounted input provenance and bounded change. The measured owner collection profile is **one input, three outputs, one proof**, with at most one owned change note. Higher implementation ceilings are not qualified activation settings.
5. **Native recovery includes real costs.** Pool unshield fees and the pinned ANON gateway's 13 bps fee on the pool-net amount are compounded in pricing. Collection debits remaining earned value, not lifetime earnings. Its minimum native proceeds cover unrecovered operator gas and the configured margin on gas and private owner fees, without counting those private fees twice. Native proceeds must reach the authorized gas operator through the verified gateway trace without consuming that operator's transaction or authorization nonce.
6. **Uncertainty retains a hold.** Unknown outcomes, incomplete history, unsupported owner payment shapes, reorgs, restore flags and migration gaps do not clear pending requests or reopen spending. Refunds are owner-executed operations, not automatic or instant payouts. Their retained budget must cover the payout and later native recovery together.

These controls do not establish unconditional zero loss. They depend on correct, complete canonical RPC evidence, finality, preserved journals, bounded accepted costs and the authorized custody process. Key theft, unauthorized nonce use or payments sent outside the accepted owner intent remain material risks. The test collection allowance is not a universal bound for arbitrary note fragmentation.

## Confirmation time and user experience

Plan for **roughly 13–19 minutes for Ethereum finality**, followed by private-wallet synchronization and proof/quote work. This is an estimate from two to three 6.4-minute epochs, not a measured service guarantee; finality can stall. The client must not advertise confirmed credit before the chain's finalized state recognizes it. See the official [proof-of-stake finality description](https://ethereum.org/developers/docs/consensus-mechanisms/pos/) and [attestation/epoch description](https://ethereum.org/developers/docs/consensus-mechanisms/pos/attestations/).

The wait is not limited to the first deposit: execution settlement and owner payment verification also require finality. BNB supports finalized-state queries, but the complete Ophis/ANON wallet latency has **not been measured in the live acceptance flow**. No instant-swap or subsecond wallet promise follows from protocol finality alone. Removing PPOI checks does not remove these chain-finality requirements; an external wallet can also apply its own policy.

## Validation and exact scope

The latest reported regression checkpoint includes the dual-RPC adapter:

| Check | Result |
| --- | --- |
| Broadcaster suite | 945 passed, 31 skipped |
| BNB-specific suite | 326 passed, 2 skipped at the preceding checkpoint; adapter coverage separately recorded below |
| Adapter-focused tests | 110 passed across the scoped Ethereum/BNB configurations; optional adapter environment both set and unset tested |
| Private client suite | 559 passed, 12 skipped |
| Type checks, builds, broadcaster image and smoke | Passed; bundle SHA-256 `3613ad1bb376eafad3abdb3b8ef76ab0c511894501cf9ccbe4a248407922ac24` |
| Adapter-inclusive static scan | Completed on the immutable v6 source snapshot; findings and limits below |
| Exact-commit CI | Pending at this checkpoint; recheck main compatibility at the final candidate commit |

Two isolated mainnet forks completed six real SDK proofs and four operator submissions each: top-up/claim, swap, withdrawal, included failure accounting, owner refund, and native collection. They exercised the actual pinned pool and ANON gateway with synthetic accounts; the production accounting and native-transfer verifier accepted the resulting evidence. Owner gas costs were measured, a real private-fee output was included, and remaining customer credit stayed backed.

| Evidence | BNB v7 | Ethereum v9 |
| --- | --- | --- |
| Source manifest SHA-256 | `41145461dcb6f2b93974b5b7c69eeaf5584bad7c07bd24b1205337413df5eeea` | `d4e837424370fab5e863328a6943a7b2afa2f917f525dd1579105c3b6a507802` |
| Measured operator + external owner gas | 0.000418031 BNB | 0.001222325448200696 ETH |
| Verified native collection | 0.001168937810000003 BNB | 0.004753997940430805 ETH |
| Required minimum including fixture margin | 0.00051073565 BNB | 0.001555674265430801 ETH |
| Retained backed customer credit | 0.000428741845602290 WBNB | 0.002691133214817958 WETH |
| Measured collection shape | 1 input / 3 outputs / 1 proof | 1 input / 3 outputs / 1 proof |

The economics exclude user bootstrap gas and guard commissioning. They are fixture observations, not production quotes. These tests used no real funds, owner wallets, live private builders or live PPOI acceptance. Public pre-fork history caching retained the original SDK root validation and never cached synthetic private outputs.

BNB v7 predates two narrow production changes included in Ethereum v9: retaining canonical nullifier-checkpoint progress across temporarily regressing finalized reads, and checking the actual singleton credit-identity row before bypassing first-initialization nonce checks. Those changes received independent review, 36 checkpoint tests per chain and broadcaster regressions of 101 Ethereum / 113 BNB passes. A redundant full BNB proof run was not represented as having occurred. The later dual-RPC adapter is outside both proof snapshots; its separate qualification is recorded below.

The read-only adapter qualification (`bnb-trace-adapter-live-probe.json`, checked 2026-11-09 at 10:24 UTC) passed using public BlastAPI historical reads and public Blockmachine traces. Adapter SHA-256: `2e4bac90d7861675d46f97f5153a738c38563633415c2d7c92e447b7d2d10d12`. It verified the historical gateway/helper pins and 13 bps base fee, a complete 19-frame nested trace for a canonical transaction at block 132549503, and a recent finalized zero-value `debug_traceCall` at block 132568048. This establishes the observed required capabilities and adapter behavior without a real transaction or production endpoint change. It does not repeat the full proof lifecycle or prove future provider availability.

The portable evidence index is `release-proof-summary.json`, SHA-256 `c666db49963430b2e101f1b2443c7432c2e1359d4e63b7b1b86088285b99ec09`, retained under the owner-controlled `ophis-railgun-evidence/prepaid-release-20261109` directory with per-file hashes, receipts, native traces and node-stop records.

## Security review methods and limits

Review used ETHSkills security/accounting guidance, Trail of Bits differential/adversarial review techniques, Ponytail change review, and independent Codex and source-only Claude analysis. Findings drove explicit note provenance, single-note recovery capacity, refund headroom, bounded authenticated query lanes, duplicate-claim cache stability, and resumable finalized nullifier scans. These are engineering reviews using those methods, **not commissioned Pashov or Trail of Bits audits or certifications**.

The latest completed static report is `codeql-final-v6/REPORT.md`, snapshot `94a334d58c2da180ceeed8102695ec3b8600be04b8bd4416f1b7d636723259c8`. Its 214-file manifest had no drift or missing current public sources at completion and includes the adapter and singleton-row bootstrap guard:

- CodeQL 2.27.4 extracted all expected JS/TS/HTML files. Official security/quality and extended queries, additional Security Lab queries, and custom decrypted-Waku/SQLite models produced 53 baseline and 47 modeled alerts, reviewed with no newly identified exploitable production finding. The one new alert is an intentional loopback mock-RPC error response in `bnb-trace-provider.test.ts`, used to verify production error sanitization. These counts are not zero findings.
- Semgrep OSS 1.136.0 scanned the 214-file snapshot with 163 applicable rules, including security-audit, secrets, JavaScript, Node.js and additional Trail of Bits/elttam/Apiiro rules. Thirteen unchanged matches were reviewed as nonblocking. Four test-only timeouts cleared on targeted retry. One invalid third-party rule and 31 test-only partial-parsing warnings remain; there was no production parsing failure. OSS analysis does not provide Semgrep Pro interprocedural coverage.

Slither/Pashov-method evidence belongs to earlier unchanged Solidity guard scope. The new TypeScript/SQLite implementation has not been described as freshly Slither-audited, Pashov-certified or formally verified with Verity. Existing Rust dependency/timer fixes are retained in this PR; their recorded audit/gate results do not replace final CI on the combined commit.

## Owner-wallet compatibility remains a launch gate

The inspected signed ANON 0.12.4 extension exposes amounts, recipient, route and fee confirmation, but its reviewed public flow does **not** expose exact private input/proof/change selection or unsigned proof export. A successful synthetic gateway proof therefore does not establish that the owner's actual ANON wallet will choose the accepted accounted notes and shape.

Historical or unclaimed notes may affect selection. Inspect them through disabled view-only synchronization before taking a new paid deposit. Do not assume an undocumented ANON export API, generate a replacement wallet, count historical notes as prepaid credit, or move funds implicitly.

Either establish an owner-compatible pre-sign path, or obtain specific approval for a bounded compatibility pilot whose visible amounts/fees fit the saved intent. A post-receipt rejection protects the ledger but cannot refund an external wallet fee already paid for an unsupported shape. One successful owner pilot qualifies its observed route and limits; it does not guarantee arbitrary future note selection. The detailed procedure and remaining recovery limits are in [PREPAID-REFUNDS.md](../../apps/broadcaster/PREPAID-REFUNDS.md).

## Custody, storage and next actions

The owner-controlled ANON gas operator is `0x001486E70A0c9291f5F55c68914eE0e4E4A604d4`. The Ambire/Ledger address `0x58707c6C1E111c21cba4C9C8caE144175F84EceE` remains the owner's treasury. The accepted Baal arrangement uses a locally unlocked software gas signer; server administrators may access that gas key. It is not a hardware-isolated signing arrangement. The broadcaster's private fee-wallet authority remains view-only, and the owner retains spending control.

Disk cleanup reclaimed approximately **81 GB** of obsolete orphaned local Anvil history; approximately **70 GiB free** was observed after subsequent builds. Wallet material, journals and recovery records were preserved. New test launchers bound persisted states and use owned cache directories with cleanup. Legitimate broadcaster journal growth and traffic still need capacity monitoring on the server; deleting recovery history is not the mitigation.

Splitting historical reads and traces still trusts both providers. Canonical chain/block binding rejects inconsistent evidence; it does not cryptographically prove that a provider's logs and traces are truthful or complete. `debug_traceCall` discloses unsigned execution calldata to the simulation provider. Protected transaction submission limits public-mempool exposure, not visibility to the simulation/read RPC operator. No paid service or service-level guarantee is assumed, and the qualified endpoint arrangement has not been activated in production.

The next steps are concrete and ordered:

1. Complete final CI/review for the exact commit. The adapter qualification, static analysis, affected regressions and rebuilt artifact are complete; preserve their source and bundle hashes. No credentials belong in this report or evidence exports.
2. Stage the exact reviewed image/configuration **disabled**, with backups, operator lock and both chain monitors. Inspect the old BNB configuration rather than restarting it unchanged. Stage approval is not public admission.
3. Have the owner unlock the existing runtime locally and run plain `sync` for read-only fee-wallet/history inspection. It does not subscribe, sign, initialize credit or reconcile payment journals. Separately quote and approve any historical cleanup or personal test-fund transfer before anchoring a new ledger nonce.
4. Run explicit `sync --initialize-credit` only after those moves are finalized. Initial creation requires latest, pending and finalized operator nonces to agree; an empty identity table cannot bypass that check. Preserve the immutable ledger, old withdrawal marker and nonce history.
5. Obtain the existing wallet's stable public account-zero credit owner and current ratcheted swap account. The prepared restricted inspection artifact displays them separately after local unlock; it is not hosted or enabled for payments. Bind explicit ledger/owner pilot settings and the approved recipient. Approve current quotes and the bounded actual ANON refund/collection compatibility test before paying.
6. Complete restricted user-paid swap, withdrawal, refund and native-recovery acceptance with canonical receipts, exact costs, remaining liabilities, private-note shape and monitoring evidence. Existing commissioning/test budgets are not automatic approval of additional spending.
7. Present the final artifact, remaining limits and live evidence for explicit merge and deployment approval. Public activation remains a separate reviewed action; no successful test automatically merges, deploys or opens admission.

Backups and restore holds must follow [BACKUP-FORMAT.md](../../apps/broadcaster/BACKUP-FORMAT.md). Do not clear pending proofs, old pilot markers, owner intents or credit identity to make acceptance pass.
