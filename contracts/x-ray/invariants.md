# Ophis Security Invariants

## Governance and solver authorization

- Only the timelock can add a solver through `AllowListGuardian`.
- Only the current guardian can remove a solver through `AllowListGuardian`.
- A guardian rotation cannot set the guardian to zero.
- A manager proposal can only be accepted by the exact pending manager.
- Initializer state changes at most once and production proxy deployment initializes atomically.
- Solver capability at Settlement execution time is equivalent to authenticator approval.

## Fee liquidation

- Every hot-key sweep destination is the immutable `feeSafe`.
- A sweep never increases the Settlement's balance of a swept asset.
- The liquidator never retains tokens or native value.
- Consolidation can call only an allowlisted venue and produce only an allowlisted output token.
- Each venue approval is exact for the resolved input and is zero when the atomic settlement finishes.
- Output-token balance increase in Settlement is at least `amountOutMin`.
- Any failed external call reverts the entire sweep or consolidation state transition.

## Vault policy

- The curator can act only while it is neither a Safe owner nor an enabled Safe module.
- Every order sells and buys allowed, distinct tokens and receives proceeds at the Safe.
- Fee amount is zero; appData and order flags match immutable policy.
- `block.timestamp < validTo <= block.timestamp + maxTtl`.
- Oracle answers are positive, complete, within bounds, and no older than configured staleness.
- When configured, sequencer status is up and its recovery grace period has elapsed.
- Buy amount is at least the oracle-derived floor after the configured slippage allowance.
- Leaked turnover plus the new order's USD value never exceeds the daily cap.
- Safe allowance to the relayer is exact for the one live sell-token order managed by the module.
- A superseded or cancelled module order is no longer presigned.
- A cancelled live order leaves zero relayer allowance for its sell token.
- Unknown or non-module order UIDs cannot be cancelled through the module.

## Vendored settlement

- Only an authenticated solver can call `settle` or `swap`.
- Filled amount never exceeds the signed order's sell/buy limit.
- Only the UID owner can invalidate or presign its order.
- VaultRelayer value-moving methods are callable only by its immutable Settlement creator.
- Interaction execution is atomic and cannot target the VaultRelayer.
- Expired storage cleanup cannot make an expired UID executable again.
- Simulation delegatecalls never persist state.
