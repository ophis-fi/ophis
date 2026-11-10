# Arbitrum fee-first private broadcasting

Status: fallback proposal backed by source review and isolated execution evidence;
not selected or implemented in the production broadcaster, release-approved or
deployed. Prefer preserving the existing Ethereum
wallet/payment model with equivalent qualified delivery. Existing signing gates
and spending limits remain.

## Verification completed 2026-11-05

An ordinary paid Arbitrum mainnet revert was verified through two read RPCs;
universal revert exclusion is not established. Thirty isolated containment tests
passed, including 2,048 fuzz executions, with independent root reproduction and
source/static review. An actual Groth16 COMMON fee proof was then accepted by
the untouched canonical Arbitrum contracts on a local state fork. The recipient
decrypted 0.001 WETH; an actual second pool call failed with `Note already spent`
while that fee persisted. Receipt/trace/account-target checks supersede a
preserved initial fixture mistake.

A deliberately stale fee proof also produced a real local outer failure using
421,213 EVM gas without another fee. This proves the wrapper alone does not
cover pre-payment invalidation. It does not test live conditional admission.
The deployed implementation identity is known, but full bytecode-matched source
and storage layout, complete conditional read sets, live inclusion enforcement,
production 7702/recovery and fee pricing/margin remain unqualified. No mainnet
transaction, merge, deployment, activation or limit increase was performed.

Reproducible evidence, raw receipts/traces and limits:
`/Users/scep/ophis-railgun-evidence/arbitrum-verification-20261105/verification-results.md`.

## Candidate fallback

Make payment for a submitted attempt independent of the trade's success. Use a
separate ordinary private RAILGUN fee transfer, then execute the trade in a
bounded call whose failure cannot revert that fee. Submit directly through the
official Arbitrum conditional sequencer API. No monthly relay subscription or
new proof circuit is part of this design; the user keeps the same private wallet.

The gas wallet still advances native ETH. The approved private fee covers the
validated maximum total gas cost plus margin, including the fee-payment leg.
The user approves this fixed fee before submission and pays it for an executed
failed trade as well as a successful trade. The output-based platform fee remains
tied to successful output. No automatic refund or fee-wallet spending authority
is introduced.

## Implementation scope

1. Verify the deployed Arbitrum RAILGUN proxy, implementation and storage layout
   against reviewed source before deriving any storage keys.
2. Add explicit note reservation/coin control so fee and operation proofs use
   disjoint existing inputs. Populate/save each proved transaction before building
   the next because the current high-level SDK uses a shared proof cache.
3. Prepare fee/principal notes during funding where possible. ERC20 shielding
   supports multiple notes; the current native-ETH helper needs a tested composer,
   since merely adding same-token requests can overwrite its allowances. Existing
   one-note balances need an explicit one-time private split or a separately
   validated chained-proof design; never reuse one input across both legs.
4. Add a separately audited execution wrapper. Only the bound gas operator can
   call it. First execute the authenticated fee-only COMMON transfer with no
   unshield and adaptContract zero, then isolate the operation. Enforce signed
   requireSuccess=true for the operation so its private spend and public actions
   roll back together on failure. Reserve post-call gas and bound calldata,
   forwarded gas and returndata copying. Preserve the existing guard/artifact.
5. Derive explicit slot conditions for the fee leg's nullifiers, accepted roots,
   proxy/implementation, pause and verification-key dependencies. Verify all
   code identities and account for the transaction's own EIP-7702 authorization.
   Nitro rechecks slot values immediately before execution; whole-storage-root
   checks can miss earlier same-block writes and must not be substituted.
6. Journal signed bytes and exact conditional publication metadata before
   disclosure. Keep short time validity bounded by the authenticated quote,
   preserve unknown outcomes and use no ordinary-RPC fallback. Confirm block-window
   units from the exact Nitro implementation before using those optional fields.
7. Distinguish paid success, paid operation failure and pre-execution rejection
   in receipts, fee assurance, accounting and browser recovery. A successful outer
   receipt alone is insufficient. Never retry a paid attempt as a new spend or
   silently charge a second fee. Preserve legacy saved proofs and journals.

## Acceptance before activation

Use isolated contract and actual-protocol fork tests for success, changed trade
delegation, stale execution nonce, swap/proof failure, inner out-of-gas, returndata
bombs and reentrancy. Every paid failure must retain the exact private fee while
restoring principal state. Test double-spent fee inputs, same-block dependency
changes, proxy/VK updates and insufficient gas; invalid fee state must be rejected
before execution by the conditional path. Verify note selection, native funding,
receipt/restart recovery, fee ceilings and actual native expenditure. Complete
independent source/tool reviews before any owner-approved bounded live acceptance.

The sequencer's conditional policy is not a consensus validity rule. A faulty
sequencer, re-sequencing/republication, unexpected outer out-of-gas, host/key
compromise or a failure before payment can still cause loss. This is protection
against the identified user-controlled races, not an absolute zero-loss promise.
A stricter financial model would require a confirmed user-funded gas deposit
before any sponsored attempt and its own privacy/custody/UX review.

References: [conditional RPC](https://developer.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/rpc-methods),
[official direct sequencer](https://developer.arbitrum.io/arbitrum-essentials/reference/node-providers).
Detailed source pins, limitations and feasibility evidence are retained in
`ophis-railgun-evidence/unblock-20261105/arbitrum-fee-first-conditional-feasibility.md`
and `railgun-fee-first-feasibility.md`. Candidate upstream source is not treated
as a deployed-bytecode/storage-layout match.
