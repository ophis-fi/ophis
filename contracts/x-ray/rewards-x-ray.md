# Ophis Rewards Distributor — X-Ray

> Pre-audit scope: `src/contracts/rewards/OphisRewardsDistributor.sol` · 162 lines · 1 contract

## 1. Overview

The contract is a finite, non-expiring USDG prize distributor on Robinhood Chain. An off-chain
reward signer authorizes a wallet, ticket ID, and fixed denomination through EIP-712. Anyone may
relay assignment and claim transactions, but the contract always transfers USDG to the signed
recipient. The immutable owner is the Ophis 1-of-2 Safe; it can pause operations and rotate only the
reward signer. There is deliberately no withdrawal or sweep path.

The system is best classified as a finite token distributor with an off-chain eligibility oracle.
The eligibility service, historical RPCs, allocation seed, signer key, relayer, USDG, and Safe are
outside this Solidity scope and are trust boundaries.

## 2. Threat model

| Actor | Capability | Trust / constraint |
|---|---|---|
| Recipient or relayer | Calls `assign` and `claim` | Cannot redirect a prize; signed recipient is bound into EIP-712 data |
| Reward signer | Authorizes all winning assignments | Hot authorization key; rotation is immediate through the owner Safe |
| Owner Safe | Pauses and rotates signer | 1-of-2; no timelock; cannot withdraw campaign funds |
| Eligibility service | Chooses qualifying wallets and ticket order | Must enforce Ophis trade, $100 minimum, 180-day age, one wallet |
| USDG | Executes `transfer` | Assumed standard six-decimal ERC-20 returning `bool` |

Key surfaces worth tracing in audit:

- Signer compromise or incorrect EIP-712 domain construction can exhaust the immutable inventory.
- The off-chain indexer is the only enforcement point for swap value, supported chain, and wallet age.
- A malicious/reentrant token is not the configured USDG, but the transfer boundary should be checked
  against state ordering and return-data behavior.
- The 1-of-2 owner threshold permits either signer to pause or rotate the reward signer immediately.
- Indefinite claims require durable key rotation, RPC, and relayer operations; already assigned claims
  remain permissionless even if the Ophis service disappears.

## 3. Invariant highlights

- `totalAssigned <= 105` and `totalAssignedValue <= 150_000_000`.
- `oneDollarAssigned <= 100` and `tenDollarAssigned <= 5`.
- A recipient and ticket ID can each be assigned at most once.
- `totalClaimed <= totalAssigned` and `totalClaimedValue <= totalAssignedValue`.
- Claim state is written before the USDG transfer; a failed transfer reverts the whole state change.

See [invariants.md](invariants.md) for guards and derivations and
[entry-points.md](entry-points.md) for the full call surface.

## 4. Integrations and proof status

- Verity model builds without `sorry`/`admit`, emits Yul/ABI/layout reports, and passes
  `--deny-unchecked-dependencies --deny-unsafe`.
- Verity reports EIP-712 hashing, `ecrecover`, ERC-20 calls, and checked-arithmetic obligations as
  assumed boundaries; the model is not bytecode-equivalence proof.
- Foundry unit tests exercise signatures, caps, replay protection, authorization, pause, and claims.
- Coverage without IR hits a pre-existing monorepo stack-depth failure; the IR-minimum retry is the
  documented fallback and has less accurate source mapping.

## 5. Readiness gaps

- Add stateful invariants and a sustained Medusa/Echidna campaign.
- Run Slither and the multi-lens Pashov audit, then resolve every confirmed finding.
- Fork-test the canonical Robinhood USDG behavior and record deployment bytecode/constructor checks.
- Treat archive-RPC availability and signer/relayer secret custody as launch-blocking operational gates.
