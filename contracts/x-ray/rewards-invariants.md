# Invariant Map

> OphisRewardsDistributor | 16 guards/assertions | 7 inferred invariants

## 1. Enforced Guards (Reference)

#### G-1
`block.chainid == 4663` · `OphisRewardsDistributor.sol:68` · pins deployment to Robinhood Chain.

#### G-2
`token != 0 && safeOwner != 0 && initialRewardSigner != 0` · `:69` · prevents unusable trust roots.

#### G-3
`!paused` · `:87` · provides incident containment for assignment and claim.

#### G-4
`ticketId > 0 && ticketId <= 105` · `:101` · binds signatures to the finite ticket namespace.

#### G-5
`rewardOf[recipient] == 0 && !assignedTicket[ticketId]` · `:102-103` · prevents wallet/ticket replay.

#### G-6
`totalAssigned < 105` · `:104` · caps lifetime reservations.

#### G-7
`oneDollarAssigned < 100 || tenDollarAssigned < 5` · `:106-111` · enforces exact denominations.

#### G-8
`v ∈ {27,28} && s <= secp256k1n/2 && recovered == rewardSigner` · `:116-119` · authenticates canonical signatures.

#### G-9
`rewardOf[recipient] > 0 && !claimed[recipient]` · `:135-137` · restricts claims to one assigned payout.

#### G-10
`msg.sender == owner` · `:82` · restricts pause and signer rotation to the Safe.

## 2. Inferred Invariants (Single-Contract)

#### I-1
Bound · On-chain: **Yes**

> `totalAssigned <= 105` and `totalAssignedValue <= 150_000_000`.

**Derivation** — guard-lift: `:104`, denomination caps `:106-111`, only writer `:124-127`, assertion `:129`.

#### I-2
Bound · On-chain: **Yes**

> `oneDollarAssigned <= 100` and `tenDollarAssigned <= 5`.

**Derivation** — guard-lift across the only write sites `:106-109,126-127`.

#### I-3
StateMachine · On-chain: **Yes**

> Each recipient transitions unassigned → assigned once; each ticket ID is consumed once.

**Derivation** — edge: zero checks `:102-103` → nonzero writes `:121-123`; no clearing writer exists.

#### I-4
StateMachine · On-chain: **Yes**

> Each recipient transitions assigned/unclaimed → claimed once.

**Derivation** — edge: false check `:137` → true write `:139`; no reverse writer exists.

#### I-5
Bound · On-chain: **Yes**

> `totalClaimed <= totalAssigned` and `totalClaimedValue <= totalAssignedValue`.

**Derivation** — guard-lift: claim precondition `:136`, one-shot state, only writes `:140-141`, assertions `:146-147`.

#### I-6
StateMachine · On-chain: **Yes**

> Failed USDG transfers cannot leave a wallet marked claimed.

**Derivation** — edge: writes `:139-141` occur before transfer `:143`; revert at `:144` atomically rolls back.

## 3. Inferred Invariants (Cross-Contract)

No cross-contract invariant is claimed because USDG is outside the Solidity scope. Its standard
`transfer(address,uint256) returns (bool)` behavior is an explicit integration assumption.

## 4. Economic Invariants

#### E-1
On-chain: **Yes**

> The configured prize inventory cannot reserve more than 150 USDG across 105 winners.

**Follows from** — `I-1` + `I-2` + `I-3`.
