# OTC Milestone C final review — 2026-09-06

Scope: PR #1229 against main `8a80365fb383dcb11cf572e9ac46945e98380ef0`.
This review covers ERC-20 execution on local Ethereum forks. Production writes
remain disabled. Milestone B's completed review does not approve C.

## Method and authority

Read the changed transaction builders, policy checks, preflight, wallet adapters,
controller, persisted recovery, forms, tests, and release workflows; traced their
callers and the installed viem receipt implementation. There is no production
Solidity delta. The Ethereum contract address, runtime hash, WETH identity, and
upstream implementation stay pinned in the manifest and contract fork suite.

An independent, read-only Codex CLI review of `dcc07014` reproduced four P2
findings. The legacy models named by the second-opinion skill were unavailable;
the installed default `gpt-6-astra` completed the review. The original review
output is `/private/tmp/ophis-otc-c-final-review.txt`. This local review is separate
from the required GitHub Codex review of the eventual merge head.

## Findings and fixes

| Finding | Before | Fix and regression |
| --- | --- | --- |
| C-FINAL-01: broadcast lock lost on reload | The hash was persisted only after receipt tracking failed. A reload during tracking lost the pending transaction. | Persist immediately after broadcast, before waiting. Clear only that hash after a known receipt; retain it on tracking failure. The recovery hook test remounts while receipt tracking is pending and checks persisted state. |
| C-FINAL-02: replacement receipt accepted | viem follows replacements, including wallet cancellations. A successful self-transfer could be reported as successful OTC execution. | The shared submission boundary accepts the original hash or a repriced replacement verified by viem to have identical transaction terms. Cancellations and different-calldata replacements enter durable recovery; the recovery acknowledgment covers replacement transactions too. The submission regression supplies a successful replacement receipt and expects the original hash to remain uncertain. |
| C-FINAL-03: noncanonical recovery key | `1` and `1.0` produced identical calldata but different persisted locks. | Use parsed base-unit amounts in the create key. The rendered-form regression verifies equivalent formatting retains the key and a different amount changes it. |
| C-FINAL-04: empty-form revocation did nothing | A positive allowance enabled revocation, but an incomplete draft supplied no revoke intent. | Revocation requires the selected token pair and exact zero approval, independently of create amounts. Both token-policy checks remain mandatory. The empty-form regression builds and decodes its revocation. |

All four findings have fixes and passing regression tests. GitHub review of
`142dcda4` added three follow-ups, also fixed: verified speed-ups count as terminal
success; object-returning hooks and recovery callbacks retain stable references;
and persisted locks are partitioned by the original Anvil/Hardhat instance ID.
The node's `hardhat_metadata` response supplies that identity (verified against
Anvil 1.5.1); it survives browser reloads and distinguishes separate fork runs.
Identity is rechecked before signing, around receipt tracking, and before clearing
a lock. Metadata reads have a ten-second timeout. A controller regression proves
that checking or clearing on fork B cannot remove fork A's recovery record. Review fixes do not
enable additional selectors, native ETH, batching, or production wallet actions.

## Static analysis

Semgrep Community scanned the changed JS/TS and workflow files with metrics off:
`p/security-audit`, `p/secrets`, `p/typescript`, `p/react`, `p/github-actions`,
`p/owasp-top-ten`, `p/cwe-top-25`, and applicable Trail of Bits, elttam, and Apiiro
rules. Official packs, Trail of Bits, and elttam reported zero findings/errors.
Apiiro reported three false positives for human-readable Cosmos fixture names
(`Fill ready`, `Cancel pending`, `Recovery required`); those objects contain
static demonstration state, with no obfuscation or execution of external input.
No actionable static-analysis finding remains.

One Apiiro rule, `javascript-obfuscation-conditions`, cannot parse under the
installed Semgrep engine (`switch ($VAR) { case ... }`). Its exclusion is explicit;
the compatible Apiiro rules complete with zero rule errors. Pro is unavailable,
so this is not a cross-file taint certification. Logs, target lists, and JSON are
under `/private/tmp/ophis-otc-c-semgrep/`. Repository CodeQL and dependency checks
provide separate CI evidence. No blanket vulnerability-free claim is made.

## Release enforcement and validation

The active `protect-main` ruleset `17378394` requires GitHub Actions checks for
frontend typecheck/build/OTC tests, OTC fork scope, seven contract invariants, six
injected-wallet browser scenarios, and fresh Codex review. Strict branch freshness
and all existing required checks are preserved. The scope check covers frontend,
workflows, scripts, contracts, and submodule configuration and has a runnable
`bash .github/scripts/otc-fork-scope.sh --self-test` regression.

Fork jobs explicitly use `https://ethereum-rpc.publicnode.com`, with no provider
secrets, endpoint fallbacks, scheduled runs, or RPC retries. The old secret proxy
is deleted. The browser job has a twenty-minute execution ceiling after the first
CI attempt passed create/cancel but exceeded the initial eight-minute ceiling.
RPC failure still fails the job. Runtime and block identity checks are unchanged.

Local OTC/navigation tests pass 36 suites and 239 tests (one explicitly optional Jest fork case skipped). Frontend typecheck, scoped lint/formatting, and gate self-tests pass. Final-head CI and authenticated Codex evidence on
[PR #1229](https://github.com/ophis-fi/ophis/pull/1229) are required before merge;
this document does not substitute for those checks. Local fork runs passed all seven contract cases and all six browser scenarios
without skips. The latest browser run passed in 1 minute 33 seconds. A Linux CI
run passed five scenarios; its race assertion expected a transient error after
polling had already replaced that state. The revised check requires the raced
order to be inactive, the exact unused allowance to remain, an accessible recovery
warning, and successful revocation after reload.

Production write enablement and EIP-5792 batching remain separate work. A deployed
read-only desk is the authorized production behavior for this release.
