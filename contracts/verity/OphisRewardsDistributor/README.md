# Ophis rewards Verity model

This is the Verity EDSL model for the finite Robinhood Chain rewards distributor. It models the
assignment and claim state machine, checked counters, one-wallet/one-ticket uniqueness, the fixed
100 × 1 USDG plus 5 × 10 USDG inventory, owner-only pause/signer rotation, EIP-712 hashing,
`ecrecover`, and the final ERC-20 transfer.

The executable Solidity contract remains the deployment source. The Verity model is an independent
security model, not a claim of byte-for-byte equivalence. Verity currently reports the static ABI
hash layout, EIP-712 digest, EVM `ecrecover`, and ERC-20 call behavior as explicit trust boundaries;
those boundaries must also be reviewed and exercised by Foundry, fuzzing, and static analysis.
The Solidity-only pre-assignment `balanceOf` solvency guard is intentionally tested at that boundary;
the independent model does not pretend to prove the external token's reported balance.

Reproduce against the current official Verity repository:

```sh
cp -R contracts/verity/OphisRewardsDistributor /path/to/verity/Contracts/
cp contracts/verity/OphisRewardsDistributor.lean /path/to/verity/Contracts/
cd /path/to/verity
lake build Contracts.OphisRewardsDistributor.OphisRewardsDistributor
lake build Contracts.OphisRewardsDistributor.Properties
lake exe verity-compiler \
  --module Contracts.OphisRewardsDistributor.OphisRewardsDistributor \
  --output artifacts/ophis-rewards/yul \
  --abi-output artifacts/ophis-rewards/abi \
  --trust-report artifacts/ophis-rewards/trust-report.json \
  --assumption-report artifacts/ophis-rewards/assumption-report.json \
  --layout-report artifacts/ophis-rewards/layout-report.json \
  --deny-unchecked-dependencies --deny-unsafe
```

The stricter `--deny-assumed-dependencies` gate is expected to reject this model because the
cryptographic and token-call boundaries are explicitly assumed by Verity. Likewise,
`--deny-local-obligations` reports the checked-arithmetic no-overflow obligations emitted by
`requireSomeUint`; the model also enforces the finite inventory bounds that make them unreachable.
These boundaries are recorded rather than hidden or described as formally proven.
