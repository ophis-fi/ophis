# Ophis wallet, token, and name safety build gate

**Date:** 2026-08-17

**Branch:** `codex/ophis-priority-lab` (local only, no upstream)

**Deployment:** Locked

## Decision

The three authorized workstreams are implemented locally:

1. wallet capability safety;
2. token-policy enforcement; and
3. Ethereum ENS and `.wei` recipient resolution.

This is not a deployment approval. Deployment remains locked until all local
checks are green and the exact Trail of Bits, Verity Lang, and Pashov review
gates have been applied to the final diff. The applicable local workflows are
installed and their results are recorded below. These results are automated
methodology and proof checks; they are not endorsements by those organizations
or by a human auditor.

No branch was pushed, no release was created, and no deployment was performed.

## Wallet capability safety

Ophis now treats wallet batching as an active-account and active-chain
capability, never as a wallet-wide assumption.

- Requests use Wallet Call API version `2.0.0` and require atomic execution.
- Only direct calls are accepted; delegate-call operations fail closed.
- Account, chain ID, target, calldata, value, and returned batch IDs are
  validated before use.
- Batch status must match version, batch ID, chain, and atomic execution.
- A confirmed result must contain only successful receipts.
- Pending, confirmed, and partial-failure statuses cannot trigger stepped
  retry. Retry is considered safe only after terminal status `400` or `500`.
- Wallet or chain changes invalidate in-flight capability and reconciliation
  results.
- Uncertain submissions are never replayed automatically.

## Token-policy enforcement

The policy is allowlist-only and currently has one reviewed chain profile:
Ethereum mainnet.

Allowed assets:

- native ETH;
- WETH;
- USDC; and
- DAI.

All other tokens and all other chains fail closed. Metadata, symbol, token-list
membership, and successful interface calls are not treated as evidence that a
token lacks taxes, rebases, callbacks, blocklists, proxy changes, or deceptive
transfer behavior.

The policy is enforced at token selection, quote construction, form validation,
regular signing, safe-bundle order creation, limit-order creation, and TWAP
creation. Signing and posting paths repeat the policy check so UI or state
bypasses cannot activate an unreviewed asset.

Adding a token requires a separate behavior and deployment review. Adding a
chain requires its own wrapped-native definition, token profile, wallet tests,
and product approval; it cannot inherit the Ethereum policy.

## Ethereum name support

Recipient resolution is read-only and Ethereum-mainnet-only.

- Direct addresses remain valid on their selected chain.
- Names must have an explicit `.eth` or `.wei` suffix.
- Bare labels and `.gwei` names are rejected.
- Names are normalized with ENSIP-15; surrounding whitespace, empty labels,
  invisible/confusable invalid forms, and malformed names fail closed.
- `.wei` support is limited to second-level names. Its registry permits a
  parent owner to reclaim a subdomain, so `.wei` subdomains are not accepted as
  payment recipients.
- Zero-address results are rejected.
- A name is resolved again immediately before signing or safe transaction
  submission, and the result must equal the address shown to the user.

Pinned Ethereum contracts:

| System | Registry                                     | Required runtime hash                                                |
| ------ | -------------------------------------------- | -------------------------------------------------------------------- |
| ENS    | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` | `0xd6bfd5d6f1384a1f6ea57b8a8412de5552f138d42021cf7c4941e33206f529e4` |
| `.wei` | `0x0000000000696760E15f265e828DB644A0c242EB` | `0x5b791c832d4373a8d4f977c37d6973a5dbe0924c6d287a2effaa549be31c0221` |

The runtime hash is checked on every forward-resolution request. ENS also
requires the returned resolver to contain code. The `.wei` implementation is
non-upgradeable and verified on Ethereum, but its explorer record has no
submitted security audit. That absence must be considered by the three named
reviewers.

Reverse resolution, avatars, text records, registration, renewal, gateway
content, and name-based operation on other chains are outside this build.

Primary review sources:

- [EIP-5792 Wallet Call API](https://eips.ethereum.org/EIPS/eip-5792);
- [ENS contracts](https://github.com/ensdomains/ens-contracts);
- [Wei Name Service contracts](https://github.com/z0r0z/wei-names);
- [verified `.wei` deployment](https://etherscan.io/address/0x0000000000696760e15f265e828db644a0c242eb#code); and
- [`@1001-digital/ethereum-names`](https://www.npmjs.com/package/@1001-digital/ethereum-names).

## Local verification

| Check                                  | Result                                                                |
| -------------------------------------- | --------------------------------------------------------------------- |
| Wallet, token, and name library suites | Pass: 99 tests                                                        |
| Focused wallet-hook suite              | Pass: 8 tests                                                         |
| Focused trade-form validation suite    | Pass: 9 tests                                                         |
| Approval-reason regression suite       | Pass: 45 tests                                                        |
| Frontend TypeScript check              | Pass                                                                  |
| Production frontend bundle             | Pass                                                                  |
| Repository-wide test target            | Pass: 27 of 27 projects                                               |
| Repository-wide lint target            | Pass: 27 of 27 projects, zero errors; configured warning debt remains |
| Landing build and browser suite        | Pass: build, unit and CSP checks, and 69 browser tests                |
| Solidity differential scope            | Pass/not applicable: no Solidity file differs from `origin/main`      |

The successful production build used the worktree-local dependency graph. An
initial attempt exposed an undeclared root-level module resolution because the
new workspace dependency had only been added to the lockfile; a full offline
workspace install created the required local link, after which the production
build passed.

## Mandatory security review gate

| Required gate                                 | Current status                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trail of Bits differential-review methodology | Pass for the reviewed worktree; no open critical or high finding. See `OPHIS_DIFFERENTIAL_REVIEW_2026-08-17.md`.                                                                  |
| Verity Lang                                   | Pass for the existing `AllowListGuardian` formal model. The local workspace has no model for these TypeScript-only changes, so it does not prove the wallet, token, or name code. |
| Pashov Solidity auditor                       | Pass/not applicable for this differential scope: no `.sol` file changed. This is not an approval of TypeScript.                                                                   |

The Verity command `lake build Contracts.AllowListGuardian` completed
successfully with two unused-variable warnings. An attempted distributor target
was absent from the local Verity workspace and is not represented as reviewed.

Deployment remains prohibited until the user reviews the final diff and gives
explicit approval. Any material code change invalidates these results and
requires the applicable checks to run again against the new final diff.

Push and release publication remain outside this gate and are not authorized by
this document.
