# Ophis Robinhood hardening differential security review

## Executive summary

| Severity | Open | Remediated during review |
| -------- | ---: | -----------------------: |
| Critical |    0 |                        0 |
| High     |    0 |                        0 |
| Medium   |    0 |                        1 |
| Low      |    0 |                        0 |

**Overall branch risk:** Low  
**Recommendation:** Approve after repository CI passes

The review covered the Robinhood integration diff from `9a71119b` through
`2d27b052`, plus the security remediation added during review. The only
actionable issue was fixed before approval: Robinhood's nested asset metadata
was previously trusted after validating only the top-level array.

## What changed

The branch adds:

- Robinhood chain documentation and canonical endpoint constants;
- a read-only production canary for chain, contract, token, and orderbook
  invariants;
- a same-origin Cloudflare Pages Function for public Robinhood asset metadata;
- contextual Stock Token information in the swap interface;
- documentation drift checks and operational documentation.

No Solidity files, dependency manifests, lockfiles, authentication paths,
transaction construction, signing logic, or settlement logic changed.

## Security finding remediated

### Medium: malformed upstream metadata could crash the trade widget

**Files:** `functions/api/robinhood/assets.ts:41`,
`apps/frontend/apps/cowswap-frontend/src/ophis/components/RobinhoodAssetContext/index.tsx:135`  
**Status:** Fixed and regression-tested  
**Blast radius:** Robinhood Chain trade-widget metadata only; quote and order
submission logic are separate.

Before remediation, the edge function accepted any array from the trusted
Robinhood endpoint. A malformed `currentMultiplier`, deployment, or trading
capability could then reach `BigInt`, `Number`, `Object.values`, or address
operations during React rendering.

The edge boundary now rejects:

- malformed or missing required asset fields;
- non-decimal or unreasonably long multipliers;
- malformed contract addresses and unsafe chain identifiers;
- malformed nested trading-capability objects;
- payloads above 500 assets.

Invalid upstream data returns a non-cacheable `502` response, and the UI already
treats metadata as optional. Regression coverage is in
`tests/functions/robinhood-assets.test.ts`.

## Test coverage and blast radius

| Changed surface         | Risk   | Coverage                                                 |
| ----------------------- | ------ | -------------------------------------------------------- |
| Robinhood asset proxy   | Medium | Schema validator tests, Functions typecheck, Semgrep     |
| Stock Token UI metadata | Medium | Data helper tests, frontend TypeScript build             |
| Production canary       | Medium | Self-test and live read-only canary                      |
| Chain/docs invariants   | Low    | Dedicated invariant test                                 |
| Docs and constants      | Low    | Docusaurus build and constant tests                      |
| GitHub Actions          | Low    | SHA-pinned actions, read-only permissions, static canary |

The new proxy has one direct browser caller. The Stock Token component is
mounted only in the trade widget and is gated on chain ID `4663`. Failure of
the optional metadata request does not block quoting or trading.

## Pashov and Trail of Bits gates

- **Pashov Solidity auditor:** Not applicable to the branch diff. The repository
  contains Solidity elsewhere, but the branch changes zero `.sol` files and
  does not alter deployed bytecode, ABIs, signing, or contract call
  construction.
- **Trail of Bits differential review:** Complete for all changed files.
- **Trail of Bits Semgrep rules:** Applicable JavaScript, GitHub Actions, and
  generic rules ran alongside Semgrep security, secrets, TypeScript, React, and
  Node.js rules. Result: zero findings across the changed-code targets.
- **Insecure defaults / sharp edges:** No new secret fallback, permissive CORS,
  unpinned action, dynamic command execution, or fail-open authorization path.
  The public RPC fallback is explicitly documented as rate-limited and can be
  overridden by supervised production configuration.
- **Dependency review:** No dependency or lockfile change. Production audit has
  zero critical, high, or moderate advisories. One inherited low-severity
  `elliptic` advisory has no patched release and was not introduced by this
  branch.

## Historical and adversarial review

No validation, access-control, or security-fix code was removed. The primary
external attacker surface is the public, GET-only asset proxy. Its upstream is
fixed in source, requests time out after five seconds, non-GET methods are
rejected, errors are not cached, and the response is schema-validated before
being returned. There is no user-controlled URL, credential, HTML injection,
filesystem access, command execution, or state mutation.

The scheduled workflow uses repository secrets only through environment
variables, runs with `contents: read`, pins third-party actions to full commit
SHAs, and performs read-only RPC/API checks.

## Methodology and limitations

**Strategy:** Surgical differential review of a large monorepo, with complete
coverage of all changed files and deeper analysis of the new external-data
boundary and workflow.

Techniques:

- baseline/head diff and history review;
- trust-boundary and data-flow tracing;
- changed-function test mapping;
- concrete malformed-upstream attack scenario;
- Semgrep changed-code scan with 160 applicable rules;
- production dependency audit;
- manual insecure-default, sharp-edge, secret, CORS, workflow-permission, and
  action-pinning review;
- repository unit, type, build, invariant, and live-canary gates.

The review does not claim a new audit of unchanged deployed smart contracts.
That is intentionally outside this branch's blast radius.
