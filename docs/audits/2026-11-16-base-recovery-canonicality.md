# Base recovery and fee snapshot review

Baseline: `23e95c139b5e5e72c35c5aa282ca80583efbc3f0`. Scope: Base fee preparation, wrap/setup/refund recovery, their shared canonical-header reader, and the setup retry control. This change does not enable Base, deploy a contract, alter saved transaction encodings or change broadcaster custody.

## Corrected behavior

- Fee conditions previously read storage by height. An A→B→A reorganization could mix branch B's fee scalar with branch A's header and create an ineligible request. All seven fee words now use one canonical block hash, followed by an uncached header check. Existing equality and upper-bound envelopes remain unchanged and readable.
- Wrap, setup and refund transitions previously combined cached headers or account state from different branches. Terminal decisions now recheck canonical receipts and applicable anchors; account code, balance, nonce and registry reads use explicit canonical hashes. Failed or unsupported reads preserve recovery records.
- Setup funding and signing use the verified balance and an ordered current head. Provisional confirmation no longer permanently blocks exact-byte retry after a reorg. Used, retired, refunded or privately pending operations remain blocked; retry never creates a new signature or payment.
- The UI exposes that recovery path without automatically invoking it. Settled credit does not hide recovery; unresolved private/prepaid activity does. New raw-header and fee-storage transport errors use fixed diagnostics.

## Validation

On Node22, the production runtime major:

| Check | Result |
| --- | --- |
| Complete private client suite | 1,345 passed; 15 optional integration cases skipped |
| Complete broadcaster suite | 1,318 passed; 12 optional/chain-conditioned cases skipped |
| Isolated real-RPC Base setup integration | 1 passed on local Anvil with synthetic wallets, no mainnet fork |
| Upstream predicate parser/evaluator replay | 115 assertions passed against five recorded/synthetic public fixtures |
| TypeScript | Client, server and broadcaster passed |
| Build | Private client and broadcaster bundle passed; shared helper is present in the transitive bundle |

Before-fix runs reproduce the fee snapshot, stale ethers cache, recovery/finality and setup retry failures. Gateway tests preserve hash selectors for Base nonce, balance and storage reads and propagate unsupported-selector errors without retrying by height. Existing gateway code/call coverage is retained.

The first full broadcaster run used this Mac's default Node26 and a long temporary socket path. Three cases failed; the unchanged suite subsequently passed completely under explicit Node22 and a short isolated temporary directory. No test assertion or timeout was weakened. The optional integration skips above are not claimed as passing live acceptance.

## Independent review and tooling

Claude Fable5.2 reviewed the source and identified additional setup ordering/retry and diagnostic issues, which were addressed. Two independent local Codex reviewers applied differential-review and Sharp Edges methods with separate API/canonical-state and UI/recovery/operations scopes. The specialized trusted-cyber reviewer was not available in this session; these two focused Sharp Edges reviews are the disclosed fallback described in CONTRIBUTING.md. They do not replace GitHub's enforced trusted-bot review or establish live acceptance.

The final offline scan covers109 production/import files. CodeQL extracted102/102 applicable source files. Semgrep and CodeQL retain21 source-reviewed informational/existing alerts, with no new unresolved finding. Gitleaks found no match in the14 changed source/test files; unchanged files and dependency/contract inputs were checked against the previous full-scan hashes. The added audit record is scanned before publication.

Solidity, guard artifacts, dependency manifests/patches and Docker dependency inputs are unchanged. Prior contract and dependency assessments (including Slither, modeled Verity checks and Trivy triage) remain inherited evidence with their original limits. This is not a new contract proof or a fresh scan of a rebuilt deployment image, and does not erase previously triaged dependency advisories. These are agent reviews using installed methodologies, not commercial audits by Trail of Bits or Pashov. Jev was not callable in this session.

## Remaining Base release gates

1. Qualify the intended live provider for canonical hash selectors on code, nonce, balance, call and storage, including nonexistent-hash negative controls and finalized-depth state. Code-level consistency checks do not authenticate a malicious or selector-ignoring endpoint.
2. Resolve the acknowledged-but-unincluded November13 transactions. A historical guard deployment used conditional submission successfully, but the later diagnostic envelopes still have no explained disposition. Offline parser compatibility does not identify the live builder decision. The existing report is [Base issue6513](https://github.com/base/base/issues/6513#issuecomment-6853052431). Two new read-only lifecycle probes returned HTTP403/non-JSON; that is inconclusive, not evidence of absent events or an unsupported method.
3. After a demonstrated route correction, reconcile all retained signed alternatives and the held nonce, then obtain bounded live inclusion/exclusion and user-paid swap, withdrawal, refund and recovery evidence. A used setup whose confirmation disappears remains conservatively blocked with its records preserved; a generalized recovery procedure for that case is not qualified. Unresolved private operations also block setup recovery until reconciliation. Prior one-transaction approvals are consumed. No ordinary-RPC fallback or removal of fee predicates is approved.
4. Complete trusted GitHub review/CI, build and verify the exact runtime image, bind monitoring/backups to the correct Base container and ledger, and perform owner unlock only for the reviewed activation. There is no verified external alert destination. Ethereum/BNB/Arbitrum runtime services and Baal's Ethereum node/mev-boost were not modified by this work.

The full local evidence is retained outside the repository under `base-completion-20261116`, including source hashes, before/after tests, tool outputs, reviewer dispositions and the unposted operator follow-up. Base remains disabled until the outstanding release gates are met.
