# Entry Points

## Protocol flow paths

`constructor(token, Safe, signer)` → owner Safe funds 150 USDG → signer authorizes assignment

`[setup above]` → `assign(recipient,ticketId,amount,v,r,s)` → permanent reservation

`[assignment above]` → `claim(recipient)` → `USDG.transfer(recipient, amount)`

`constructor` → `setPaused(bool)` or `setRewardSigner(address)`  ◄── Safe approval

## Permissionless

| Function | Parameters | State modified | Value flow | Guard |
|---|---|---|---|---|
| `assign` | recipient/ticket/amount (signed), v/r/s (user-supplied) | assignment mappings and four counters | none | pause, inventory, uniqueness, EIP-712 signer |
| `claim` | recipient (user-controlled) | claim mapping and two counters | distributor → signed recipient | pause, assigned, not claimed; CEI |

Both functions are intentionally relayable. `assign` has no external contract call; `ecrecover` is
an EVM precompile. `claim` writes all state before calling the immutable reward token.

## Admin-only

| Function | Authority | Parameters | State modified |
|---|---|---|---|
| `setPaused` | immutable owner Safe | next state | `paused` |
| `setRewardSigner` | immutable owner Safe | nonzero signer | `rewardSigner` |

There is no owner transfer, token withdrawal, arbitrary call, deadline, or upgrade function.
